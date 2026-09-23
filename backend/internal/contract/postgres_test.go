package contract

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// These integration tests truncate user_contracts and contracts. Use a dedicated
// test database with the users, chains, and contract migrations already applied.
// Do not use t.Parallel: every test resets the same contract tables.

func TestPostgresContractRepository_GetOrCreateDeployment(t *testing.T) {
	_, repo, _ := setupPostgresContractTest(t)
	ctx := t.Context()

	const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	const mixedAddress = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd"
	const chainID int64 = 11155111
	const startBlock int64 = 123

	created, err := repo.GetOrCreateDeployment(ctx, chainID, address, startBlock)
	if err != nil {
		t.Fatalf("create deployment: %v", err)
	}
	if created == nil {
		t.Fatal("expected a deployment, got nil")
	}
	if created.ID <= 0 {
		t.Fatalf("expected generated ID > 0, got %d", created.ID)
	}
	if created.Address != address || created.ChainID != chainID || created.StartBlock != startBlock {
		t.Fatalf("unexpected deployment fields: %+v", created)
	}
	if !created.IndexingEnabled || created.CreatedAt.IsZero() {
		t.Fatalf("expected indexing enabled and a creation timestamp, got %+v", created)
	}

	existing, err := repo.GetOrCreateDeployment(ctx, chainID, mixedAddress, 999)
	if err != nil {
		t.Fatalf("get existing deployment: %v", err)
	}
	if existing == nil {
		t.Fatal("expected the existing deployment, got nil")
	}
	if existing.ID != created.ID {
		t.Errorf("expected existing ID %d, got %d", created.ID, existing.ID)
	}
	if existing.Address != address || existing.ChainID != chainID {
		t.Errorf("expected the same normalized deployment, got %+v", existing)
	}
	if existing.StartBlock != startBlock {
		t.Errorf("expected stored startBlock %d, not the conflicting input 999; got %d", startBlock, existing.StartBlock)
	}
}

func TestPostgresContractRepository_StartBlockCheck(t *testing.T) {
	db, _, _ := setupPostgresContractTest(t)

	// Bypass service validation to pin the database CHECK itself.
	_, err := db.ExecContext(t.Context(), `
		INSERT INTO contracts (chain_id, address, start_block, indexing_enabled, created_at, updated_at)
		VALUES ($1, $2, $3, true, NOW(), NOW())
	`, 1, fmt.Sprintf("0x%040x", 1), -1)

	requireContractPostgresError(t, err, "23514")
}

func TestPostgresContractRepository_DeploymentUniqueConstraint(t *testing.T) {
	db, repo, _ := setupPostgresContractTest(t)
	deployment := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 1), 100)

	// A raw duplicate must fail rather than take the repository's conflict path.
	_, err := db.ExecContext(t.Context(), `
		INSERT INTO contracts (chain_id, address, start_block, indexing_enabled, created_at, updated_at)
		VALUES ($1, $2, $3, true, NOW(), NOW())
	`, deployment.ChainID, deployment.Address, 200)

	pgErr := requireContractPostgresError(t, err, "23505")
	if pgErr.ConstraintName != "uq_contracts_chain_address" {
		t.Errorf("expected constraint uq_contracts_chain_address, got %q", pgErr.ConstraintName)
	}
}

func TestPostgresContractRepository_InsertTrackingDuplicate(t *testing.T) {
	_, repo, userID := setupPostgresContractTest(t)
	deployment := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 1), 100)
	insertContractTestTracking(t, repo, userID, deployment.ID, "Treasury", true)

	err := repo.InsertTracking(t.Context(), userID, deployment.ID, "Duplicate", false)
	if !errors.Is(err, ErrAlreadyTracked) {
		t.Fatalf("expected ErrAlreadyTracked from pk_user_contracts mapping, got: %v", err)
	}
}

func TestPostgresContractRepository_UserDeleteCascade(t *testing.T) {
	db, repo, userID := setupPostgresContractTest(t)
	ctx := t.Context()
	deployment := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 1), 100)
	insertContractTestTracking(t, repo, userID, deployment.ID, "Treasury", true)

	if _, err := db.ExecContext(ctx, "DELETE FROM users WHERE id = $1", userID); err != nil {
		t.Fatalf("delete user: %v", err)
	}

	var trackingCount int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM user_contracts WHERE user_id = $1", userID).Scan(&trackingCount); err != nil {
		t.Fatalf("count deleted user's trackings: %v", err)
	}
	if trackingCount != 0 {
		t.Errorf("expected cascading deletion of trackings, got %d rows", trackingCount)
	}

	var deploymentCount int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM contracts WHERE id = $1", deployment.ID).Scan(&deploymentCount); err != nil {
		t.Fatalf("count deployment after user deletion: %v", err)
	}
	if deploymentCount != 1 {
		t.Errorf("expected shared deployment to remain, got %d rows", deploymentCount)
	}
}

func TestPostgresContractRepository_DeploymentDeleteNoAction(t *testing.T) {
	db, repo, userID := setupPostgresContractTest(t)
	deployment := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 1), 100)
	insertContractTestTracking(t, repo, userID, deployment.ID, "Treasury", true)

	_, err := db.ExecContext(t.Context(), "DELETE FROM contracts WHERE id = $1", deployment.ID)
	requireContractPostgresError(t, err, "23503")
}

func TestPostgresContractRepository_GetTracking(t *testing.T) {
	db, repo, userID := setupPostgresContractTest(t)
	ctx := t.Context()
	foreignUserID := seedContractTestUser(t, db)
	deployment := createContractTestDeployment(t, repo, 137, fmt.Sprintf("0x%040x", 1), 456)
	insertContractTestTracking(t, repo, userID, deployment.ID, "Polygon treasury", false)

	// Distinguish the tracking timestamp from the deployment's timestamp.
	trackingCreatedAt := time.Date(2025, time.January, 2, 3, 4, 5, 0, time.UTC)
	if _, err := db.ExecContext(ctx, `
		UPDATE user_contracts SET created_at = $1
		WHERE user_id = $2 AND contract_id = $3
	`, trackingCreatedAt, userID, deployment.ID); err != nil {
		t.Fatalf("set tracking timestamp: %v", err)
	}

	got, err := repo.GetTracking(ctx, userID, deployment.ID)
	if err != nil {
		t.Fatalf("get owner's tracking: %v", err)
	}
	if got == nil {
		t.Fatal("expected tracking, got nil")
	}
	if got.ID != deployment.ID || got.Address != deployment.Address || got.ChainID != deployment.ChainID || got.StartBlock != deployment.StartBlock {
		t.Errorf("unexpected joined deployment fields: %+v", got)
	}
	if got.Label != "Polygon treasury" || got.Enabled {
		t.Errorf("unexpected user-specific tracking fields: %+v", got)
	}
	if !got.CreatedAt.Equal(trackingCreatedAt) {
		t.Errorf("expected tracking createdAt %v, got %v", trackingCreatedAt, got.CreatedAt)
	}

	_, err = repo.GetTracking(ctx, foreignUserID, deployment.ID)
	if !errors.Is(err, ErrContractNotFound) {
		t.Errorf("expected ErrContractNotFound for foreign user, got: %v", err)
	}

	// Only one deployment exists after this test's table reset.
	_, err = repo.GetTracking(ctx, userID, deployment.ID+1)
	if !errors.Is(err, ErrContractNotFound) {
		t.Errorf("expected ErrContractNotFound for nonexistent deployment, got: %v", err)
	}
}

func TestPostgresContractRepository_ListForUser(t *testing.T) {
	db, repo, userA := setupPostgresContractTest(t)
	userB := seedContractTestUser(t, db)

	a1 := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 0xaa01), 10)
	a2 := createContractTestDeployment(t, repo, 137, fmt.Sprintf("0x%040x", 0xbeef02), 20)
	a3 := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 0xcafe03), 30)
	b1 := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 0xbeef99), 40)

	insertContractTestTracking(t, repo, userA, a1.ID, "Alpha Treasury", true)
	insertContractTestTracking(t, repo, userA, a2.ID, "Polygon Savings", false)
	insertContractTestTracking(t, repo, userA, a3.ID, "Operations", true)
	insertContractTestTracking(t, repo, userB, b1.ID, "Foreign Treasury", true)

	enabled, disabled := true, false
	tests := []struct {
		name      string
		filter    ListFilter
		wantIDs   []int64
		wantTotal int
	}{
		{
			name:      "no filter returns only user A's trackings",
			filter:    ListFilter{Page: 1, PageSize: 20},
			wantIDs:   []int64{a1.ID, a2.ID, a3.ID},
			wantTotal: 3,
		},
		{
			name:      "chain 1",
			filter:    ListFilter{Page: 1, PageSize: 20, ChainID: 1},
			wantIDs:   []int64{a1.ID, a3.ID},
			wantTotal: 2,
		},
		{
			name:      "chain 137",
			filter:    ListFilter{Page: 1, PageSize: 20, ChainID: 137},
			wantIDs:   []int64{a2.ID},
			wantTotal: 1,
		},
		{
			name:      "enabled true",
			filter:    ListFilter{Page: 1, PageSize: 20, Enabled: &enabled},
			wantIDs:   []int64{a1.ID, a3.ID},
			wantTotal: 2,
		},
		{
			name:      "enabled false",
			filter:    ListFilter{Page: 1, PageSize: 20, Enabled: &disabled},
			wantIDs:   []int64{a2.ID},
			wantTotal: 1,
		},
		{
			name:      "search matches label",
			filter:    ListFilter{Page: 1, PageSize: 20, Search: "  tReAsUrY  "},
			wantIDs:   []int64{a1.ID},
			wantTotal: 1,
		},
		{
			name:      "search matches address",
			filter:    ListFilter{Page: 1, PageSize: 20, Search: "  BeEf  "},
			wantIDs:   []int64{a2.ID},
			wantTotal: 1,
		},
		{
			name:      "percent is literal, not a wildcard",
			filter:    ListFilter{Page: 1, PageSize: 20, Search: "%"},
			wantIDs:   nil,
			wantTotal: 0,
		},
		{
			name:      "page past last preserves total",
			filter:    ListFilter{Page: 3, PageSize: 2},
			wantIDs:   nil,
			wantTotal: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, total, err := repo.ListForUser(t.Context(), userA, tt.filter)
			if err != nil {
				t.Fatalf("list trackings: %v", err)
			}
			if total != tt.wantTotal {
				t.Errorf("expected total %d, got %d", tt.wantTotal, total)
			}

			// Compare membership here; a separate test pins SQL ordering.
			gotIDs := make([]int64, len(got))
			for i, tracking := range got {
				gotIDs[i] = tracking.ID
			}
			wantIDs := slices.Clone(tt.wantIDs)
			slices.Sort(gotIDs)
			slices.Sort(wantIDs)
			if !slices.Equal(gotIDs, wantIDs) {
				t.Errorf("expected contract IDs %v, got %v", wantIDs, gotIDs)
			}
		})
	}
}

func TestPostgresContractRepository_ListSortOrder(t *testing.T) {
	db, repo, userID := setupPostgresContractTest(t)
	ctx := t.Context()

	base := time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)
	createdAt := []time.Time{
		base.Add(2 * time.Hour),
		base.Add(time.Hour),
		base.Add(time.Hour), // Deliberate tie to pin contract ID descending.
		base,
	}
	ids := make([]int64, len(createdAt))

	for i, trackingCreatedAt := range createdAt {
		// Equal deployment timestamps ensure ordering comes from uc.created_at.
		err := db.QueryRowContext(ctx, `
			INSERT INTO contracts (chain_id, address, start_block, indexing_enabled, created_at, updated_at)
			VALUES ($1, $2, $3, true, $4, $4)
			RETURNING id
		`, 1, fmt.Sprintf("0x%040x", i+1), 100, base.Add(-24*time.Hour)).Scan(&ids[i])
		if err != nil {
			t.Fatalf("seed deployment %d: %v", i, err)
		}

		_, err = db.ExecContext(ctx, `
			INSERT INTO user_contracts (user_id, contract_id, label, enabled, created_at, updated_at)
			VALUES ($1, $2, $3, true, $4, $4)
		`, userID, ids[i], fmt.Sprintf("sort-%d", i), trackingCreatedAt)
		if err != nil {
			t.Fatalf("seed tracking %d: %v", i, err)
		}
	}

	got, total, err := repo.ListForUser(ctx, userID, ListFilter{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("list sorted trackings: %v", err)
	}
	if total != len(ids) || len(got) != len(ids) {
		t.Fatalf("expected %d rows and total, got rows=%d total=%d", len(ids), len(got), total)
	}

	wantIDs := []int64{ids[0], ids[2], ids[1], ids[3]}
	wantCreatedAt := []time.Time{createdAt[0], createdAt[2], createdAt[1], createdAt[3]}
	for i, tracking := range got {
		if tracking.ID != wantIDs[i] {
			t.Errorf("position %d: expected contract ID %d, got %d", i, wantIDs[i], tracking.ID)
		}
		if !tracking.CreatedAt.Equal(wantCreatedAt[i]) {
			t.Errorf("position %d: expected createdAt %v, got %v", i, wantCreatedAt[i], tracking.CreatedAt)
		}
	}
}

func TestPostgresContractRepository_UpdateTracking(t *testing.T) {
	db, repo, userID := setupPostgresContractTest(t)
	ctx := t.Context()
	foreignUserID := seedContractTestUser(t, db)
	deployment := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 1), 100)
	insertContractTestTracking(t, repo, userID, deployment.ID, "Original label", true)

	// Reset to a known old timestamp before each update; do not rely on sleeps
	// or two NOW() calls producing distinct values at database precision.
	oldUpdatedAt := time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)
	resetUpdatedAt := func() {
		t.Helper()
		if _, err := db.ExecContext(ctx, `
			UPDATE user_contracts SET updated_at = $1
			WHERE user_id = $2 AND contract_id = $3
		`, oldUpdatedAt, userID, deployment.ID); err != nil {
			t.Fatalf("reset updated_at: %v", err)
		}
	}

	resetUpdatedAt()
	label := "Updated label"
	got, err := repo.UpdateTracking(ctx, userID, deployment.ID, &label, nil)
	if err != nil {
		t.Fatalf("update label only: %v", err)
	}
	if got == nil {
		t.Fatal("expected updated tracking, got nil")
	}
	if got.Label != label || !got.Enabled {
		t.Errorf("label-only update must preserve enabled=true, got %+v", got)
	}
	if updatedAt := contractTestTrackingUpdatedAt(t, db, userID, deployment.ID); !updatedAt.After(oldUpdatedAt) {
		t.Errorf("label update did not advance updated_at: before=%v after=%v", oldUpdatedAt, updatedAt)
	}

	resetUpdatedAt()
	enabled := false
	got, err = repo.UpdateTracking(ctx, userID, deployment.ID, nil, &enabled)
	if err != nil {
		t.Fatalf("update enabled only: %v", err)
	}
	if got == nil {
		t.Fatal("expected updated tracking, got nil")
	}
	if got.Label != label || got.Enabled {
		t.Errorf("enabled-only update must preserve the label and set enabled=false, got %+v", got)
	}
	updatedAtBeforeForeign := contractTestTrackingUpdatedAt(t, db, userID, deployment.ID)
	if !updatedAtBeforeForeign.After(oldUpdatedAt) {
		t.Errorf("enabled update did not advance updated_at: before=%v after=%v", oldUpdatedAt, updatedAtBeforeForeign)
	}

	foreignLabel, foreignEnabled := "Foreign edit", true
	_, err = repo.UpdateTracking(ctx, foreignUserID, deployment.ID, &foreignLabel, &foreignEnabled)
	if !errors.Is(err, ErrContractNotFound) {
		t.Fatalf("expected ErrContractNotFound for foreign user update, got: %v", err)
	}

	unchanged, err := repo.GetTracking(ctx, userID, deployment.ID)
	if err != nil {
		t.Fatalf("get owner tracking after foreign update: %v", err)
	}
	if unchanged == nil {
		t.Fatal("expected owner's tracking to remain, got nil")
	}
	if unchanged.Label != label || unchanged.Enabled {
		t.Errorf("foreign update changed the owner's row: %+v", unchanged)
	}
	if updatedAt := contractTestTrackingUpdatedAt(t, db, userID, deployment.ID); !updatedAt.Equal(updatedAtBeforeForeign) {
		t.Errorf("foreign update changed updated_at: before=%v after=%v", updatedAtBeforeForeign, updatedAt)
	}
}

func TestPostgresContractRepository_DeleteTracking(t *testing.T) {
	db, repo, userID := setupPostgresContractTest(t)
	ctx := t.Context()
	deployment := createContractTestDeployment(t, repo, 1, fmt.Sprintf("0x%040x", 1), 100)
	insertContractTestTracking(t, repo, userID, deployment.ID, "Treasury", true)

	var deploymentsBefore int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM contracts").Scan(&deploymentsBefore); err != nil {
		t.Fatalf("count deployments before deletion: %v", err)
	}

	if err := repo.DeleteTracking(ctx, userID, deployment.ID); err != nil {
		t.Fatalf("first tracking deletion: %v", err)
	}
	if _, err := repo.GetTracking(ctx, userID, deployment.ID); !errors.Is(err, ErrContractNotFound) {
		t.Errorf("expected deleted tracking to be absent, got: %v", err)
	}

	if err := repo.DeleteTracking(ctx, userID, deployment.ID); !errors.Is(err, ErrContractNotFound) {
		t.Errorf("expected ErrContractNotFound on second deletion, got: %v", err)
	}

	var deploymentsAfter int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM contracts").Scan(&deploymentsAfter); err != nil {
		t.Fatalf("count deployments after deletion: %v", err)
	}
	if deploymentsAfter != deploymentsBefore {
		t.Errorf("tracking deletion changed deployment count: before=%d after=%d", deploymentsBefore, deploymentsAfter)
	}
}

func setupPostgresContractTest(t *testing.T) (*sql.DB, *PostgresRepository, int64) {
	t.Helper()
	ctx := t.Context()

	// Gate and connection setup copied from internal/wallet/postgres_test.go.
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("skipping integration test:DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("error initializing database: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
	})

	if err := db.Ping(); err != nil {
		t.Fatalf("error connecting database:%v", err)
	}

	// Include both tables in one statement: PostgreSQL requires the referencing
	// table even when it is empty. Keep user_contracts (child) before contracts.
	if _, err := db.ExecContext(ctx, "TRUNCATE user_contracts, contracts"); err != nil {
		t.Fatalf("truncate contract tables: %v", err)
	}
	t.Cleanup(func() {
		if _, err := db.ExecContext(context.Background(), "TRUNCATE user_contracts, contracts"); err != nil {
			t.Errorf("clean up contract tables: %v", err)
		}
	})

	// Chains 1, 137, and 11155111 must already be seeded by migration 0004.
	userID := seedContractTestUser(t, db)
	return db, NewPostgresRepository(db), userID
}

func seedContractTestUser(t *testing.T, db *sql.DB) int64 {
	t.Helper()

	email := fmt.Sprintf("contract-pg-%d@example.com", time.Now().UnixNano())
	var userID int64
	err := db.QueryRowContext(t.Context(), `
		INSERT INTO users (email, password_hash)
		VALUES ($1, $2)
		RETURNING id
	`, email, "not-used-by-contract-tests").Scan(&userID)
	if err != nil {
		t.Fatalf("seed test user: %v", err)
	}

	t.Cleanup(func() {
		if _, err := db.ExecContext(context.Background(), "DELETE FROM users WHERE id = $1", userID); err != nil {
			t.Errorf("clean up test user %d: %v", userID, err)
		}
	})
	return userID
}

func createContractTestDeployment(t *testing.T, repo *PostgresRepository, chainID int64, address string, startBlock int64) *Contract {
	t.Helper()

	deployment, err := repo.GetOrCreateDeployment(t.Context(), chainID, address, startBlock)
	if err != nil {
		t.Fatalf("seed deployment: %v", err)
	}
	if deployment == nil {
		t.Fatal("expected seeded deployment, got nil")
	}
	return deployment
}

func insertContractTestTracking(t *testing.T, repo *PostgresRepository, userID, contractID int64, label string, enabled bool) {
	t.Helper()

	if err := repo.InsertTracking(t.Context(), userID, contractID, label, enabled); err != nil {
		t.Fatalf("seed tracking for user %d, contract %d: %v", userID, contractID, err)
	}
}

func requireContractPostgresError(t *testing.T, err error, code string) *pgconn.PgError {
	t.Helper()

	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("expected PostgreSQL error %s, got: %v", code, err)
	}
	if pgErr.Code != code {
		t.Fatalf("expected PostgreSQL error %s, got %s: %v", code, pgErr.Code, pgErr)
	}
	return pgErr
}

func contractTestTrackingUpdatedAt(t *testing.T, db *sql.DB, userID, contractID int64) time.Time {
	t.Helper()

	var updatedAt time.Time
	if err := db.QueryRowContext(t.Context(), `
		SELECT updated_at FROM user_contracts
		WHERE user_id = $1 AND contract_id = $2
	`, userID, contractID).Scan(&updatedAt); err != nil {
		t.Fatalf("read tracking updated_at: %v", err)
	}
	return updatedAt
}
