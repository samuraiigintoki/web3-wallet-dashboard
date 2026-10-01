package wallet_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgresWalletRepo_Integration(t *testing.T) {
	ctx := t.Context()

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

	repo := wallet.NewPostgresWalletRepo(db)

	userID := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "Test",
	}
	created, err := repo.Create(ctx, userID, createWallet)
	if err != nil {
		t.Fatalf("error during creation :%v", err)
	}
	if created.ID <= 0 {
		t.Fatalf("expected valid generated database ID (> 0), got %d", created.ID)
	}

	_, err = repo.Create(ctx, userID, createWallet)
	if err == nil {
		t.Error("expected error on inserting duplicate, got nil")
	}
	if !errors.Is(err, wallet.ErrWalletDuplicate) {
		t.Errorf("expected: %v, got: %v", wallet.ErrWalletDuplicate, err)
	}

	fetched, err := repo.GetByID(ctx, userID, created.ID)
	if err != nil {
		t.Fatalf("expected no errors, got: %v", err)
	}
	if fetched.Address != created.Address {
		t.Errorf("expected address %s, got %s", created.Address, fetched.Address)
	}

	_, err = repo.GetByID(ctx, userID, 99999999)
	if err == nil {
		t.Error("expected error for non-existent id, got nil")
	}
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("expected errors.Is(err,wallet.ErrWalletNotFound) to be true, got error: %v", err)
	}

}

func TestWalletRepository_CancelledContext(t *testing.T) {
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

	repo := wallet.NewPostgresWalletRepo(db)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err = repo.GetByID(ctx, 1, 1)

	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got: %v", err)
	}

}

func TestPostgresUpdateLabel(t *testing.T) {
	ctx := t.Context()

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

	repo := wallet.NewPostgresWalletRepo(db)

	userID := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "pg original label",
	}
	created, err := repo.Create(ctx, userID, createWallet)
	if err != nil {
		t.Fatalf("error during creation: %v", err)
	}

	updated, err := repo.Update(ctx, userID, created.ID, "pg new label")
	if err != nil {
		t.Fatalf("error during update: %v", err)
	}
	if updated.Label != "pg new label" {
		t.Errorf("expected label %q, got %q", "pg new label", updated.Label)
	}
	if !updated.CreatedAt.Equal(created.CreatedAt) {
		t.Errorf("expected createdAt %v, got %v", created.CreatedAt, updated.CreatedAt)
	}

	fetched, err := repo.GetByID(ctx, userID, created.ID)
	if err != nil {
		t.Fatalf("expected no error fetching after update, got: %v", err)
	}
	if fetched.Label != "pg new label" {
		t.Errorf("expected persisted label %q, got %q", "pg new label", fetched.Label)
	}
}

func TestPostgresDelete(t *testing.T) {
	ctx := t.Context()

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

	repo := wallet.NewPostgresWalletRepo(db)

	userID := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "pg delete me",
	}
	created, err := repo.Create(ctx, userID, createWallet)
	if err != nil {
		t.Fatalf("error during creation: %v", err)
	}

	if err := repo.Delete(ctx, userID, created.ID); err != nil {
		t.Fatalf("expected no error deleting, got: %v", err)
	}

	_, err = repo.GetByID(ctx, userID, created.ID)
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("expected errors.Is(err, wallet.ErrWalletNotFound) to be true, got: %v", err)
	}
}

func TestPostgresDeleteNotFound(t *testing.T) {
	ctx := t.Context()

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

	repo := wallet.NewPostgresWalletRepo(db)

	userID := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "pg second delete",
	}
	created, err := repo.Create(ctx, userID, createWallet)
	if err != nil {
		t.Fatalf("error during creation: %v", err)
	}

	if err := repo.Delete(ctx, userID, created.ID); err != nil {
		t.Fatalf("expected no error on first delete, got: %v", err)
	}

	err = repo.Delete(ctx, userID, created.ID)
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("expected errors.Is(err, wallet.ErrWalletNotFound) on second delete, got: %v", err)
	}
}

// seedWalletTestUser inserts a throwaway user row: migration 0006 makes
// wallets.user_id a NOT NULL foreign key into users, so owner-scoped wallet
// rows need a real owner. Mirrors contract/postgres_test.go's user fixture.
func seedWalletTestUser(t *testing.T, db *sql.DB) int64 {
	t.Helper()

	email := fmt.Sprintf("wallet-pg-%d@example.com", time.Now().UnixNano())
	var userID int64
	err := db.QueryRowContext(t.Context(), `
		INSERT INTO users (email, password_hash)
		VALUES ($1, $2)
		RETURNING id
	`, email, "not-used-by-wallet-tests").Scan(&userID)
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

// Owner scoping: an id that belongs to another user must be indistinguishable
// from an id that does not exist. GetByID, Update and Delete all carry the
// user_id predicate, so the read, the write and the delete agree.
func TestPostgresWalletRepo_OwnerScoping(t *testing.T) {
	ctx := t.Context()

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

	repo := wallet.NewPostgresWalletRepo(db)

	userA := seedWalletTestUser(t, db)
	userB := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	created, err := repo.Create(ctx, userA, wallet.Wallet{Address: uniqueAddr, ChainID: 1, Label: "A wallet"})
	if err != nil {
		t.Fatalf("user A create: %v", err)
	}

	// B holds a token but not the row: A's id reads as not found.
	if _, err := repo.GetByID(ctx, userB, created.ID); !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("user B get by A's id: expected ErrWalletNotFound, got: %v", err)
	}

	// A reads the same id fine.
	got, err := repo.GetByID(ctx, userA, created.ID)
	if err != nil {
		t.Fatalf("user A get by own id: %v", err)
	}
	if got.ID != created.ID || got.Label != "A wallet" {
		t.Errorf("user A get by own id: expected id %d label %q, got id %d label %q", created.ID, "A wallet", got.ID, got.Label)
	}

	// B cannot rewrite or remove it either.
	if _, err := repo.Update(ctx, userB, created.ID, "hijacked by B"); !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("user B update of A's id: expected ErrWalletNotFound, got: %v", err)
	}
	if err := repo.Delete(ctx, userB, created.ID); !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("user B delete of A's id: expected ErrWalletNotFound, got: %v", err)
	}

	// The row survived every probe, unchanged.
	after, err := repo.GetByID(ctx, userA, created.ID)
	if err != nil {
		t.Fatalf("user A get after B's probes: %v", err)
	}
	if after.Label != "A wallet" {
		t.Errorf("expected the label to survive user B's probes, got %q", after.Label)
	}

	// Lists are owner scoped: B sees nothing, A sees exactly its row.
	if _, totalB, err := repo.List(ctx, userB, wallet.WalletFilter{Page: 1, PageSize: 20}); err != nil {
		t.Fatalf("user B list: %v", err)
	} else if totalB != 0 {
		t.Errorf("expected user B's list to be empty, got total %d", totalB)
	}
	if _, totalA, err := repo.List(ctx, userA, wallet.WalletFilter{Page: 1, PageSize: 20}); err != nil {
		t.Fatalf("user A list: %v", err)
	} else if totalA != 1 {
		t.Errorf("expected user A's list to hold exactly its row, got total %d", totalA)
	}
}

// Two users may save the same (address, chain): the unique moved from
// (address, chain_id) to (user_id, chain_id, address). The duplicate branch in
// Create is keyed to the new constraint name, so this test also pins that the
// name PostgreSQL enforces is the one the 23505 check reads.
func TestPostgresWalletRepo_CrossUserDuplicate(t *testing.T) {
	ctx := t.Context()

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

	repo := wallet.NewPostgresWalletRepo(db)

	userA := seedWalletTestUser(t, db)
	userB := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	first, err := repo.Create(ctx, userA, wallet.Wallet{Address: uniqueAddr, ChainID: 1, Label: "A copy"})
	if err != nil {
		t.Fatalf("user A first create: %v", err)
	}

	second, err := repo.Create(ctx, userB, wallet.Wallet{Address: uniqueAddr, ChainID: 1, Label: "B copy"})
	if err != nil {
		t.Fatalf("user B create on the same (address, chain): expected success, got: %v", err)
	}
	if second.ID == first.ID {
		t.Errorf("expected two rows, got id %d twice", first.ID)
	}

	_, err = repo.Create(ctx, userA, wallet.Wallet{Address: uniqueAddr, ChainID: 1, Label: "A again"})
	if !errors.Is(err, wallet.ErrWalletDuplicate) {
		t.Errorf("user A repeated create: expected ErrWalletDuplicate through the scoped unique, got: %v", err)
	}

	// The 23505 branch reads uq_wallets_user_chain_address. Assert that is the
	// name PostgreSQL enforces on wallets and that the legacy name is gone.
	var scopedName, legacyName int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM pg_constraint
		WHERE conrelid = 'wallets'::regclass AND conname = 'uq_wallets_user_chain_address'
	`).Scan(&scopedName); err != nil {
		t.Fatalf("count scoped unique constraint: %v", err)
	}
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM pg_constraint
		WHERE conrelid = 'wallets'::regclass AND conname = 'unique_address_chain'
	`).Scan(&legacyName); err != nil {
		t.Fatalf("count legacy unique constraint: %v", err)
	}
	if scopedName != 1 {
		t.Errorf("expected uq_wallets_user_chain_address on wallets, found %d rows", scopedName)
	}
	if legacyName != 0 {
		t.Errorf("expected unique_address_chain to be gone from wallets, found %d rows", legacyName)
	}
}

// Deleting a user cascades to their wallets and their sessions, and leaves
// another user's wallet and session alone. Mirrors the contracts cascade test.
func TestPostgresWalletRepo_UserDeleteCascade(t *testing.T) {
	ctx := t.Context()

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

	repo := wallet.NewPostgresWalletRepo(db)

	userA := seedWalletTestUser(t, db)
	userB := seedWalletTestUser(t, db)

	addrA := fmt.Sprintf("0x%040x", time.Now().UnixNano())
	addrB := fmt.Sprintf("0x%040x", time.Now().UnixNano()+1)

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = ANY($1)", pqArray(addrA, addrB))
	})

	walletA, err := repo.Create(ctx, userA, wallet.Wallet{Address: addrA, ChainID: 1, Label: "A wallet"})
	if err != nil {
		t.Fatalf("user A create: %v", err)
	}
	walletB, err := repo.Create(ctx, userB, wallet.Wallet{Address: addrB, ChainID: 1, Label: "B wallet"})
	if err != nil {
		t.Fatalf("user B create: %v", err)
	}

	seedWalletTestSession(t, db, userA)
	seedWalletTestSession(t, db, userB)

	if _, err := db.ExecContext(ctx, "DELETE FROM users WHERE id = $1", userA); err != nil {
		t.Fatalf("delete user A: %v", err)
	}

	// A's wallet and session went with the user.
	if got := countWalletTestRows(t, db, "SELECT COUNT(*) FROM wallets WHERE id = $1", walletA.ID); got != 0 {
		t.Errorf("expected user A's wallet to be deleted with the user, found %d rows", got)
	}
	if got := countWalletTestRows(t, db, "SELECT COUNT(*) FROM user_sessions WHERE user_id = $1", userA); got != 0 {
		t.Errorf("expected user A's sessions to be deleted with the user, found %d rows", got)
	}

	// B's wallet and session are untouched.
	if got := countWalletTestRows(t, db, "SELECT COUNT(*) FROM wallets WHERE id = $1", walletB.ID); got != 1 {
		t.Errorf("expected user B's wallet to survive, found %d rows", got)
	}
	if got := countWalletTestRows(t, db, "SELECT COUNT(*) FROM user_sessions WHERE user_id = $1", userB); got != 1 {
		t.Errorf("expected user B's session to survive, found %d rows", got)
	}
}

// seedWalletTestSession gives a user one live session row, matching the shape
// auth writes: a hashed token with the fixed 7-day TTL.
func seedWalletTestSession(t *testing.T, db *sql.DB, userID int64) {
	t.Helper()

	_, err := db.ExecContext(context.Background(), `
		INSERT INTO user_sessions (user_id, token_hash, expires_at)
		VALUES ($1, $2, NOW() + INTERVAL '7 days')
	`, userID, fmt.Sprintf("wallet-test-session-%d-%d", time.Now().UnixNano(), userID))
	if err != nil {
		t.Fatalf("seed session for user %d: %v", userID, err)
	}
}

func countWalletTestRows(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()

	var got int
	if err := db.QueryRowContext(context.Background(), query, args...).Scan(&got); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	return got
}

// pqArray renders a text[] literal for the cleanup statement above. Wallets are
// deleted by address, so the two test addresses are cleaned in one statement.
func pqArray(values ...string) string {
	return "{" + strings.Join(values, ",") + "}"
}
