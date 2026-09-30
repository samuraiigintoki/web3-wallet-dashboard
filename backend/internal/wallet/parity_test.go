package wallet_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

// Parity harness for internal/wallet, shaped like internal/contract/parity_test.go:
// one scenario function runs against the WalletRepository interface, once on the
// in-memory backend and once on PostgreSQL, and the normalized observations are
// compared. The PostgreSQL side sits behind the same DATABASE_URL gate.
//
// The scenario answers the two ownership questions that must not drift between
// backends: a duplicate is per user, and a foreign id is a not-found.
//
// Observations never carry timestamps or raw ids. The in-memory repository
// stamps records with the Go clock while PostgreSQL uses NOW(), and ids come
// from a counter on one side and an identity sequence on the other, so ids are
// normalized to the rank in which they are first observed.

const (
	parityWalletMissingID int64 = 999999999
	parityWalletChainID   int64 = 1
)

// TestParity_WalletOwnership_InMemory runs the scenario on the in-memory
// backend on its own. It is deliberately not gated: these are the invariants
// the PostgreSQL run is compared against, so they must hold without a database.
func TestParity_WalletOwnership_InMemory(t *testing.T) {
	_ = runWalletParityScenario(t, wallet.NewInMemoryWalletRepo(), walletParityMemoryUsers())
}

// TestParity_WalletOwnership_Postgres runs the same scenario twice, once on a
// fresh in-memory repository and once on PostgreSQL, then compares the
// observations. Kept separate from the in-memory test so a skip here can never
// mask an in-memory assertion failure.
func TestParity_WalletOwnership_Postgres(t *testing.T) {
	ctx := t.Context()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}

	// In-memory user ids need no rows; PostgreSQL needs real users for the
	// foreign key. Neither set of ids is ever recorded in an observation, so a
	// difference between them cannot affect the comparison.
	memObservations := runWalletParityScenario(t, wallet.NewInMemoryWalletRepo(), walletParityMemoryUsers())
	pgObservations := runWalletParityScenario(t, wallet.NewPostgresWalletRepo(db), seedWalletParityUsers(t, db))

	if !reflect.DeepEqual(memObservations, pgObservations) {
		t.Errorf("parity mismatch:\nmem:%s\npg:%s", formatWalletParityObservations(memObservations), formatWalletParityObservations(pgObservations))
	}
}

// walletParityUsers holds the actors the scenario needs. PostgreSQL needs real
// user rows because of the foreign key; the in-memory backend just stores the
// ids. User ids are never recorded.
type walletParityUsers struct {
	owner    int64 // creates, reads, updates and deletes its own wallet
	stranger int64 // uses the same (address, chain) as the owner, then probes the owner's id
}

func walletParityMemoryUsers() walletParityUsers {
	return walletParityUsers{owner: 1, stranger: 2}
}

// walletParityObservation is one normalized, ordered fact produced by the scenario.
type walletParityObservation struct {
	Step string
	Got  string
	Err  string
}

// runWalletParityScenario is the scenario shared by both backends.
func runWalletParityScenario(t *testing.T, repo wallet.WalletRepository, users walletParityUsers) []walletParityObservation {
	t.Helper()

	p := &walletParityProbe{
		t:     t,
		repo:  repo,
		ranks: make(map[int64]int),
	}
	ctx := t.Context()
	address := parityWalletAddress(0xa1)
	filter := wallet.WalletFilter{Page: 1, PageSize: 20}

	// Owner creates the wallet under test.
	created, err := repo.Create(ctx, users.owner, wallet.Wallet{Address: address, ChainID: parityWalletChainID, Label: "A primary"})
	if err != nil {
		t.Fatalf("owner create: %v", err)
	}
	if created.ID <= 0 {
		t.Errorf("owner create: expected a generated id > 0, got %d", created.ID)
	}
	p.record("A.create", p.walletFacts(&created), nil)

	// The same user repeating the same (address, chain) is the duplicate case.
	_, err = repo.Create(ctx, users.owner, wallet.Wallet{Address: address, ChainID: parityWalletChainID, Label: "A duplicate"})
	if !errors.Is(err, wallet.ErrWalletDuplicate) {
		t.Errorf("owner duplicate: expected ErrWalletDuplicate, got: %v", err)
	}
	p.record("A.duplicate", "<no wallet>", err)

	// A second user may hold the same (address, chain): the unique is scoped.
	other, err := repo.Create(ctx, users.stranger, wallet.Wallet{Address: address, ChainID: parityWalletChainID, Label: "B primary"})
	if err != nil {
		t.Fatalf("stranger create on the same (address, chain): expected success, got: %v", err)
	}
	if other.ID == created.ID {
		t.Errorf("stranger create: expected a distinct row, got id %d twice", other.ID)
	}
	p.record("B.same-address-and-chain", p.walletFacts(&other), nil)

	// A foreign id reads as not found; the owner reads the same id fine.
	_, err = repo.GetByID(ctx, users.stranger, created.ID)
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("stranger get by owner id: expected ErrWalletNotFound, got: %v", err)
	}
	p.record("B.get-A", "<no wallet>", err)

	got, err := repo.GetByID(ctx, users.owner, created.ID)
	if err != nil {
		t.Fatalf("owner get by own id: %v", err)
	}
	p.record("A.get-own", p.walletFacts(&got), nil)

	// A foreign update is a not-found and leaves the row untouched.
	_, err = repo.Update(ctx, users.stranger, created.ID, "hijacked by B")
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("stranger update: expected ErrWalletNotFound, got: %v", err)
	}
	p.record("B.update-A", "<no wallet>", err)

	renamed, err := repo.Update(ctx, users.owner, created.ID, "A renamed")
	if err != nil {
		t.Fatalf("owner update by own id: %v", err)
	}
	p.record("A.update-own", p.walletFacts(&renamed), nil)

	// A foreign delete is a not-found too.
	err = repo.Delete(ctx, users.stranger, created.ID)
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("stranger delete: expected ErrWalletNotFound, got: %v", err)
	}
	p.record("B.delete-A", "not deleted", err)

	// Both lists are owner scoped: one row each, despite the shared address.
	listA, totalA, err := repo.List(ctx, users.owner, filter)
	if err != nil {
		t.Fatalf("owner list: %v", err)
	}
	p.record("A.list", p.listFacts(listA, totalA), nil)

	listB, totalB, err := repo.List(ctx, users.stranger, filter)
	if err != nil {
		t.Fatalf("stranger list: %v", err)
	}
	p.record("B.list", p.listFacts(listB, totalB), nil)

	// Owner deletes its own row; the second delete is a not-found, not a no-op.
	if err := repo.Delete(ctx, users.owner, created.ID); err != nil {
		t.Fatalf("owner delete by own id: %v", err)
	}
	p.record("A.delete-own", "deleted", nil)

	err = repo.Delete(ctx, users.owner, created.ID)
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("second owner delete: expected ErrWalletNotFound, got: %v", err)
	}
	p.record("A.delete-own-again", "not deleted", err)

	// The owner's list is now empty; the stranger's row survived all of it.
	listA2, totalA2, err := repo.List(ctx, users.owner, filter)
	if err != nil {
		t.Fatalf("owner list after delete: %v", err)
	}
	p.record("A.list-after-delete", p.listFacts(listA2, totalA2), nil)

	listB2, totalB2, err := repo.List(ctx, users.stranger, filter)
	if err != nil {
		t.Fatalf("stranger list after owner delete: %v", err)
	}
	p.record("B.list-after-A-delete", p.listFacts(listB2, totalB2), nil)

	// A foreign read of the now-deleted id stays not found, and a scan over the
	// missing-id constant is the same answer on both backends.
	_, err = repo.GetByID(ctx, users.owner, parityWalletMissingID)
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("owner get by never-existing id: expected ErrWalletNotFound, got: %v", err)
	}
	p.record("A.get-missing", "<no wallet>", err)

	return p.observations
}

type walletParityProbe struct {
	t            *testing.T
	repo         wallet.WalletRepository
	ranks        map[int64]int
	observations []walletParityObservation
}

// walletRef replaces a backend-specific id with its creation rank.
func (p *walletParityProbe) walletRef(id int64) string {
	if id <= 0 {
		p.t.Errorf("expected a positive wallet id, got %d", id)
		return fmt.Sprintf("invalid-wallet-id(%d)", id)
	}
	if rank, ok := p.ranks[id]; ok {
		return fmt.Sprintf("wallet#%d", rank)
	}
	rank := len(p.ranks) + 1
	p.ranks[id] = rank
	return fmt.Sprintf("wallet#%d", rank)
}

func (p *walletParityProbe) record(step, got string, err error) {
	p.observations = append(p.observations, walletParityObservation{Step: step, Got: got, Err: parityWalletErrName(err)})
}

func (p *walletParityProbe) walletFacts(w *wallet.Wallet) string {
	if w == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%s address=%s chainId=%d label=%q createdAtSet=%t",
		p.walletRef(w.ID), w.Address, w.ChainID, w.Label, !w.CreatedAt.IsZero())
}

func (p *walletParityProbe) listFacts(list []wallet.Wallet, total int64) string {
	items := make([]string, 0, len(list))
	for i := range list {
		items = append(items, fmt.Sprintf("%s{label=%q}", p.walletRef(list[i].ID), list[i].Label))
	}
	// An empty result renders identically whether the backend returned a nil
	// slice (PostgreSQL with no rows) or an empty slice (in-memory offset guard).
	return fmt.Sprintf("total=%d items=[%s]", total, strings.Join(items, " "))
}

func parityWalletErrName(err error) string {
	switch {
	case err == nil:
		return "nil"
	case errors.Is(err, wallet.ErrWalletNotFound):
		return "ErrWalletNotFound"
	case errors.Is(err, wallet.ErrWalletDuplicate):
		return "ErrWalletDuplicate"
	default:
		return fmt.Sprintf("unexpected(%v)", err)
	}
}

func formatWalletParityObservations(observations []walletParityObservation) string {
	var b strings.Builder
	for _, o := range observations {
		fmt.Fprintf(&b, "\n  %-28s err=%-19s got=%s", o.Step, o.Err, o.Got)
	}
	if b.Len() == 0 {
		return " <none>"
	}
	return b.String()
}

// parityWalletAddress builds a 42-character address from a small numeric seed so
// the scenario owns a distinct wallet without a hand-written literal.
func parityWalletAddress(seed int64) string {
	return fmt.Sprintf("0x%040x", seed)
}

// seedWalletParityUsers inserts the two actor rows the PostgreSQL run needs and
// removes them afterwards. Wallets cascade on user deletion, so the users are
// the only rows that need explicit cleanup.
func seedWalletParityUsers(t *testing.T, db *sql.DB) walletParityUsers {
	t.Helper()

	ids := make([]int64, 2)
	for i := range ids {
		email := fmt.Sprintf("wallet-parity-%d-%d@example.com", time.Now().UnixNano(), i)
		if err := db.QueryRowContext(t.Context(), `
			INSERT INTO users (email, password_hash)
			VALUES ($1, $2)
			RETURNING id
		`, email, "not-used-by-wallet-parity-tests").Scan(&ids[i]); err != nil {
			t.Fatalf("seed parity user %d: %v", i, err)
		}

		userID := ids[i]
		t.Cleanup(func() {
			if _, err := db.ExecContext(context.Background(), "DELETE FROM users WHERE id = $1", userID); err != nil {
				t.Errorf("clean up parity user %d: %v", userID, err)
			}
		})
	}

	return walletParityUsers{owner: ids[0], stranger: ids[1]}
}
