package contract_test

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
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
)

// Parity harness for internal/contract, shaped like internal/chain/parity_test.go:
// one scenario function runs against the Repository interface, once on the
// in-memory backend and once on PostgreSQL. The PostgreSQL side sits behind the
// same DATABASE_URL gate the chain parity tests use.
//
// Observations never carry timestamps: the in-memory repository stamps records
// with the Go clock while PostgreSQL uses NOW(), so the two clocks differ by
// design. Timestamps are checked for presence only.
//
// Deployment ids differ by design too (in-memory counts from 1, PostgreSQL uses
// an identity sequence), so each id is normalized to the rank in which it is
// first observed. Ranks stay comparable because both backends execute the same
// script in the same order.

const (
	parityMissingDeploymentID int64 = 999999999

	parityChainEthereum int64 = 1
	parityChainPolygon  int64 = 137
	parityChainSepolia  int64 = 11155111
)

// TestParity_ContractRepository_InMemory runs the scenario on the in-memory
// backend on its own. It is deliberately not gated: these are the invariants the
// PostgreSQL run is compared against, so they must hold without a database.
func TestParity_ContractRepository_InMemory(t *testing.T) {
	_ = runContractParityScenario(t, contract.NewInMemoryRepository(), parityMemoryUsers())
}

// TestParity_ContractRepository_Postgres runs the same scenario twice: once on a
// fresh in-memory repository and once on PostgreSQL, then compares the normalized
// observations. Kept separate from the in-memory test so a skip here can never
// mask an in-memory assertion failure.
func TestParity_ContractRepository_Postgres(t *testing.T) {
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

	// Complete reset: user_contracts references contracts, so both tables are
	// named in one statement and the child table comes first.
	if _, err := db.ExecContext(ctx, "TRUNCATE user_contracts, contracts"); err != nil {
		t.Fatalf("truncate contract tables: %v", err)
	}

	// In-memory user ids need no rows; PostgreSQL needs real users for the
	// foreign key. Neither set of ids is ever recorded in an observation.
	memObservations := runContractParityScenario(t, contract.NewInMemoryRepository(), parityMemoryUsers())
	pgObservations := runContractParityScenario(t, contract.NewPostgresRepository(db), seedParityUsers(t, db, 5))

	// The Repository interface exposes no deployment count or getter, so
	// "exactly one deployment" is pinned here, where rows are observable. The
	// in-memory backend is pinned by id identity inside the scenario.
	assertParityDeploymentCount(t, db, parityChainEthereum, parityAddress(0xa1), 1)

	if !reflect.DeepEqual(memObservations, pgObservations) {
		t.Errorf("parity mismatch:\nmem:%s\npg:%s", formatParityObservations(memObservations), formatParityObservations(pgObservations))
	}
}

// parityMemoryUsers returns the actor ids used by standalone in-memory runs.
func parityMemoryUsers() parityUsers {
	return parityUsers{
		owner:       1,
		stranger:    2,
		firstOfTwo:  3,
		secondOfTwo: 4,
		lister:      5,
	}
}

// parityUsers holds the actor ids the scenario needs. PostgreSQL needs real user
// rows because of the foreign key; the in-memory backend just stores the ids.
// User ids are never recorded: they legitimately differ between backends.
type parityUsers struct {
	owner       int64 // scenarios A-D
	stranger    int64 // tracks nothing, used for foreign-user probes
	firstOfTwo  int64 // scenario E
	secondOfTwo int64 // scenario E
	lister      int64 // scenario F, with a list matrix of its own
}

// parityObservation is one normalized, ordered fact produced by the scenario.
type parityObservation struct {
	Step string
	Got  string
	Err  string
}

// runContractParityScenario is the scenario shared by both backends.
func runContractParityScenario(t *testing.T, repo contract.Repository, users parityUsers) []parityObservation {
	t.Helper()

	p := &parityProbe{
		t:     t,
		ctx:   t.Context(),
		repo:  repo,
		ranks: make(map[int64]int),
	}

	deploymentA := parityScenarioA(p)
	parityScenarioB(p, users.owner, deploymentA)
	parityScenarioC(p, users.owner, users.stranger, deploymentA)
	parityScenarioD(p, users.owner, users.stranger)
	parityScenarioE(p, users.firstOfTwo, users.secondOfTwo)
	parityScenarioF(p, users.lister)

	return p.observations
}

type parityProbe struct {
	t            *testing.T
	ctx          context.Context
	repo         contract.Repository
	ranks        map[int64]int
	observations []parityObservation
}

// deploymentRef replaces a backend-specific id with its creation rank.
func (p *parityProbe) deploymentRef(id int64) string {
	if id <= 0 {
		p.t.Errorf("expected a positive deployment id, got %d", id)
		return fmt.Sprintf("invalid-deployment-id(%d)", id)
	}
	if rank, ok := p.ranks[id]; ok {
		return fmt.Sprintf("deployment#%d", rank)
	}
	rank := len(p.ranks) + 1
	p.ranks[id] = rank
	return fmt.Sprintf("deployment#%d", rank)
}

func (p *parityProbe) record(step, got string, err error) {
	p.observations = append(p.observations, parityObservation{Step: step, Got: got, Err: parityErrName(err)})
}

func (p *parityProbe) contractFacts(c *contract.Contract) string {
	if c == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%s address=%s chainId=%d startBlock=%d indexingEnabled=%t createdAtSet=%t",
		p.deploymentRef(c.ID), c.Address, c.ChainID, c.StartBlock, c.IndexingEnabled, !c.CreatedAt.IsZero())
}

func (p *parityProbe) trackingFacts(tc *contract.TrackedContract) string {
	if tc == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%s address=%s chainId=%d startBlock=%d label=%q enabled=%t createdAtSet=%t",
		p.deploymentRef(tc.ID), tc.Address, tc.ChainID, tc.StartBlock, tc.Label, tc.Enabled, !tc.CreatedAt.IsZero())
}

func (p *parityProbe) listFacts(list []contract.TrackedContract, total int) string {
	items := make([]string, 0, len(list))
	for _, tc := range list {
		items = append(items, fmt.Sprintf("%s{label=%q enabled=%t}", p.deploymentRef(tc.ID), tc.Label, tc.Enabled))
	}
	// An empty result renders identically whether the backend returned a nil
	// slice (PostgreSQL with no rows) or an empty slice (in-memory offset guard).
	return fmt.Sprintf("total=%d items=[%s]", total, strings.Join(items, " "))
}

// Scenario A: get-or-create is idempotent on the canonical (chain, address) key.
func parityScenarioA(p *parityProbe) *contract.Contract {
	t := p.t
	address := parityAddress(0xa1)

	created, err := p.repo.GetOrCreateDeployment(p.ctx, parityChainEthereum, parityMixedCase(address), 10)
	if err != nil {
		t.Fatalf("A: create deployment from a mixed-case address: %v", err)
	}
	if created == nil {
		t.Fatal("A: expected a deployment, got nil")
	}
	if created.ID <= 0 {
		t.Errorf("A: expected a generated deployment id > 0, got %d", created.ID)
	}
	if created.Address != address {
		t.Errorf("A: expected canonical lowercase address %s, got %s", address, created.Address)
	}
	if created.ChainID != parityChainEthereum {
		t.Errorf("A: expected chainId %d, got %d", parityChainEthereum, created.ChainID)
	}
	if created.StartBlock != 10 {
		t.Errorf("A: expected startBlock 10, got %d", created.StartBlock)
	}
	if !created.IndexingEnabled {
		t.Error("A: expected new deployments to be indexing enabled")
	}
	if created.CreatedAt.IsZero() {
		t.Error("A: expected createdAt to be set")
	}
	p.record("A.create-from-mixed-case", p.contractFacts(created), nil)

	existing, err := p.repo.GetOrCreateDeployment(p.ctx, parityChainEthereum, address, 99)
	if err != nil {
		t.Fatalf("A: get-or-create the same (chain, address) again: %v", err)
	}
	if existing == nil {
		t.Fatal("A: expected the existing deployment, got nil")
	}
	if existing.ID != created.ID {
		t.Errorf("A: expected one deployment per (chain, address), got first=%d second=%d", created.ID, existing.ID)
	}
	if existing.Address != address {
		t.Errorf("A: expected the stored address to stay canonical, got %s", existing.Address)
	}
	if existing.StartBlock != 10 {
		t.Errorf("A: expected the stored startBlock 10 to win over the conflicting 99, got %d", existing.StartBlock)
	}
	p.record("A.repeat-with-different-start-block", p.contractFacts(existing), nil)

	return created
}

// Scenario B: a (user, contract) pair can only be tracked once.
func parityScenarioB(p *parityProbe, owner int64, deploymentA *contract.Contract) {
	t := p.t

	if err := p.repo.InsertTracking(p.ctx, owner, deploymentA.ID, "Treasury main", true); err != nil {
		t.Fatalf("B: first tracking insert: %v", err)
	}
	p.record("B.first-insert", p.deploymentRef(deploymentA.ID), nil)

	err := p.repo.InsertTracking(p.ctx, owner, deploymentA.ID, "Second attempt", false)
	if !errors.Is(err, contract.ErrAlreadyTracked) {
		t.Errorf("B: expected ErrAlreadyTracked for a duplicate (user, contract) pair, got: %v", err)
	}
	p.record("B.duplicate-insert", p.deploymentRef(deploymentA.ID), err)
}

// Scenario C: reads are scoped to the tracking owner.
func parityScenarioC(p *parityProbe, owner, stranger int64, deploymentA *contract.Contract) {
	t := p.t

	got, err := p.repo.GetTracking(p.ctx, owner, deploymentA.ID)
	if err != nil {
		t.Fatalf("C: owner get: %v", err)
	}
	if got == nil {
		t.Fatal("C: expected the owner's tracking, got nil")
	}
	// The rejected duplicate must not have overwritten the stored tracking.
	if got.Label != "Treasury main" || !got.Enabled {
		t.Errorf("C: expected the first insert to survive the duplicate: %+v", got)
	}
	p.record("C.owner", p.trackingFacts(got), nil)

	foreign, err := p.repo.GetTracking(p.ctx, stranger, deploymentA.ID)
	if !errors.Is(err, contract.ErrContractNotFound) {
		t.Errorf("C: expected ErrContractNotFound for a foreign user, got: %v", err)
	}
	if foreign != nil {
		t.Errorf("C: expected no tracking for a foreign user, got %+v", foreign)
	}
	p.record("C.foreign-user", p.trackingFacts(foreign), err)

	missing, err := p.repo.GetTracking(p.ctx, owner, parityMissingDeploymentID)
	if !errors.Is(err, contract.ErrContractNotFound) {
		t.Errorf("C: expected ErrContractNotFound for a nonexistent deployment, got: %v", err)
	}
	if missing != nil {
		t.Errorf("C: expected no tracking for a nonexistent deployment, got %+v", missing)
	}
	p.record("C.nonexistent-deployment", p.trackingFacts(missing), err)
}

// Scenario D: partial updates, and updates never reach another user's row.
func parityScenarioD(p *parityProbe, owner, stranger int64) {
	t := p.t

	deployment, err := p.repo.GetOrCreateDeployment(p.ctx, parityChainSepolia, parityAddress(0xd1), 321)
	if err != nil {
		t.Fatalf("D: create deployment: %v", err)
	}
	if deployment == nil {
		t.Fatal("D: expected a deployment, got nil")
	}
	if err := p.repo.InsertTracking(p.ctx, owner, deployment.ID, "Original D", true); err != nil {
		t.Fatalf("D: seed tracking: %v", err)
	}

	label := "Renamed D"
	updated, err := p.repo.UpdateTracking(p.ctx, owner, deployment.ID, &label, nil)
	if err != nil {
		t.Fatalf("D: label-only update: %v", err)
	}
	p.assertUpdateReturnsStored("D.update-label-only", updated, owner, deployment.ID)
	if updated.Label != label {
		t.Errorf("D: expected label %q, got %q", label, updated.Label)
	}
	if !updated.Enabled {
		t.Error("D: a label-only update must leave enabled=true")
	}
	p.record("D.update-label-only", p.trackingFacts(updated), err)

	disabled := false
	updated, err = p.repo.UpdateTracking(p.ctx, owner, deployment.ID, nil, &disabled)
	if err != nil {
		t.Fatalf("D: enabled-only update: %v", err)
	}
	p.assertUpdateReturnsStored("D.update-enabled-only", updated, owner, deployment.ID)
	if updated.Label != label {
		t.Errorf("D: an enabled-only update must keep label %q, got %q", label, updated.Label)
	}
	if updated.Enabled {
		t.Error("D: expected enabled=false after the enabled-only update")
	}
	p.record("D.update-enabled-only", p.trackingFacts(updated), err)

	both := "Both D"
	enabled := true
	updated, err = p.repo.UpdateTracking(p.ctx, owner, deployment.ID, &both, &enabled)
	if err != nil {
		t.Fatalf("D: combined update: %v", err)
	}
	p.assertUpdateReturnsStored("D.update-both", updated, owner, deployment.ID)
	if updated.Label != both || !updated.Enabled {
		t.Errorf("D: expected label %q and enabled=true, got %+v", both, updated)
	}
	p.record("D.update-both", p.trackingFacts(updated), err)

	hijackLabel := "Hijacked"
	hijackEnabled := false
	_, err = p.repo.UpdateTracking(p.ctx, stranger, deployment.ID, &hijackLabel, &hijackEnabled)
	if !errors.Is(err, contract.ErrContractNotFound) {
		t.Errorf("D: expected ErrContractNotFound for a foreign user update, got: %v", err)
	}
	p.record("D.foreign-user-update", p.deploymentRef(deployment.ID), err)

	unchanged, err := p.repo.GetTracking(p.ctx, owner, deployment.ID)
	if err != nil {
		t.Fatalf("D: owner get after the foreign update attempt: %v", err)
	}
	if unchanged == nil {
		t.Fatal("D: expected the owner's tracking to survive, got nil")
	}
	if unchanged.Label != both || !unchanged.Enabled {
		t.Errorf("D: a foreign update changed the owner's row: %+v", unchanged)
	}
	p.record("D.owner-row-after-foreign-update", p.trackingFacts(unchanged), nil)
}

// Scenario E: deleting a tracking leaves other users and the deployment intact.
func parityScenarioE(p *parityProbe, first, second int64) {
	t := p.t

	deployment, err := p.repo.GetOrCreateDeployment(p.ctx, parityChainEthereum, parityAddress(0xe1), 55)
	if err != nil {
		t.Fatalf("E: create deployment: %v", err)
	}
	if deployment == nil {
		t.Fatal("E: expected a deployment, got nil")
	}
	if err := p.repo.InsertTracking(p.ctx, first, deployment.ID, "E1 label", true); err != nil {
		t.Fatalf("E: seed first user's tracking: %v", err)
	}
	if err := p.repo.InsertTracking(p.ctx, second, deployment.ID, "E2 label", false); err != nil {
		t.Fatalf("E: seed second user's tracking: %v", err)
	}
	p.record("E.two-users-track-one-deployment", p.deploymentRef(deployment.ID), nil)

	if err := p.repo.DeleteTracking(p.ctx, first, deployment.ID); err != nil {
		t.Fatalf("E: first user's delete: %v", err)
	}
	p.record("E.first-delete", p.deploymentRef(deployment.ID), nil)

	err = p.repo.DeleteTracking(p.ctx, first, deployment.ID)
	if !errors.Is(err, contract.ErrContractNotFound) {
		t.Errorf("E: expected ErrContractNotFound on the second delete, got: %v", err)
	}
	p.record("E.second-delete", p.deploymentRef(deployment.ID), err)

	other, err := p.repo.GetTracking(p.ctx, second, deployment.ID)
	if err != nil {
		t.Fatalf("E: second user's tracking after the other user's delete: %v", err)
	}
	if other == nil {
		t.Fatal("E: expected the second user's tracking to survive, got nil")
	}
	if other.Label != "E2 label" || other.Enabled {
		t.Errorf("E: unexpected second user tracking fields: %+v", other)
	}
	if other.Address != deployment.Address || other.ChainID != deployment.ChainID || other.StartBlock != deployment.StartBlock {
		t.Errorf("E: expected the shared deployment to survive, got %+v", other)
	}
	p.record("E.other-user-intact", p.trackingFacts(other), nil)

	list, total, err := p.repo.ListForUser(p.ctx, first, contract.ListFilter{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("E: first user's list after deleting: %v", err)
	}
	if total != 0 || len(list) != 0 {
		t.Errorf("E: expected an empty list for the deleting user, got total=%d items=%d", total, len(list))
	}
	p.record("E.deleting-user-list", p.listFacts(list, total), nil)
}

// Scenario F: the filter matrix. Invariant metadata stays identical across
// backends while everything shaped by the clock is normalized away.
func parityScenarioF(p *parityProbe, user int64) {
	t := p.t

	type seed struct {
		chainID    int64
		address    string
		startBlock int64
		label      string
		enabled    bool
	}
	seeds := []seed{
		{parityChainEthereum, parityAddress(0xf1), 100, "Alpha Treasury", true},
		{parityChainPolygon, parityAddress(0xf2), 200, "Ops 100% reserve", false},
		{parityChainSepolia, parityAddressWithTail("beef"), 300, "Beta Savings", true},
		{parityChainEthereum, parityAddress(0xf4), 400, "Gamma Escrow", false},
	}

	ids := make([]int64, len(seeds))
	for i, s := range seeds {
		created, err := p.repo.GetOrCreateDeployment(p.ctx, s.chainID, s.address, s.startBlock)
		if err != nil {
			t.Fatalf("F: seed deployment %d: %v", i, err)
		}
		if created == nil {
			t.Fatalf("F: seed deployment %d: got nil", i)
		}
		ids[i] = created.ID
		p.deploymentRef(created.ID)

		if err := p.repo.InsertTracking(p.ctx, user, created.ID, s.label, s.enabled); err != nil {
			t.Fatalf("F: seed tracking %d: %v", i, err)
		}
	}

	// Creation order must map to ascending ids on every backend. That is what
	// makes the created_at DESC, id DESC ordering fully deterministic here:
	// in-memory timestamps and PostgreSQL NOW() may tie, but a tie always breaks
	// on the same side of the comparison.
	for i := 1; i < len(ids); i++ {
		if ids[i-1] >= ids[i] {
			t.Fatalf("F: expected ascending ids in creation order, got %v", ids)
		}
	}

	enabled, disabled := true, false
	matrix := []struct {
		step        string
		filter      contract.ListFilter
		wantIndexes []int
		wantTotal   int
	}{
		// Page and PageSize are always >= 1: the repository applies no defaults,
		// the service normalizes before calling it.
		{"F.no-filter", contract.ListFilter{Page: 1, PageSize: 20}, []int{3, 2, 1, 0}, 4},
		{"F.filter-chain-1", contract.ListFilter{Page: 1, PageSize: 20, ChainID: parityChainEthereum}, []int{3, 0}, 2},
		{"F.filter-chain-137", contract.ListFilter{Page: 1, PageSize: 20, ChainID: parityChainPolygon}, []int{1}, 1},
		{"F.filter-enabled-true", contract.ListFilter{Page: 1, PageSize: 20, Enabled: &enabled}, []int{2, 0}, 2},
		{"F.filter-enabled-false", contract.ListFilter{Page: 1, PageSize: 20, Enabled: &disabled}, []int{3, 1}, 2},
		{"F.search-label-normalized", contract.ListFilter{Page: 1, PageSize: 20, Search: "  AlPhA  "}, []int{0}, 1},
		{"F.search-address-normalized", contract.ListFilter{Page: 1, PageSize: 20, Search: "  BeEf  "}, []int{2}, 1},
		// Literal matching: STRPOS in PostgreSQL, strings.Contains in memory. A
		// wildcard reading of the term would match all four labels.
		{"F.search-literal-percent-in-label", contract.ListFilter{Page: 1, PageSize: 20, Search: "100%"}, []int{1}, 1},
		{"F.search-literal-percent-only", contract.ListFilter{Page: 1, PageSize: 20, Search: "%"}, []int{1}, 1},
		{"F.pagination-page-1", contract.ListFilter{Page: 1, PageSize: 2}, []int{3, 2}, 4},
		{"F.pagination-page-2", contract.ListFilter{Page: 2, PageSize: 2}, []int{1, 0}, 4},
		{"F.pagination-past-last", contract.ListFilter{Page: 3, PageSize: 2}, nil, 4},
	}

	for _, tc := range matrix {
		list, total, err := p.repo.ListForUser(p.ctx, user, tc.filter)
		if err != nil {
			t.Errorf("%s: expected no error, got: %v", tc.step, err)
			p.record(tc.step, "<list failed>", err)
			continue
		}

		if total != tc.wantTotal {
			t.Errorf("%s: expected total %d, got %d", tc.step, tc.wantTotal, total)
		}
		if len(list) != len(tc.wantIndexes) {
			t.Errorf("%s: expected %d items, got %d", tc.step, len(tc.wantIndexes), len(list))
		} else {
			for i, wantIndex := range tc.wantIndexes {
				if list[i].ID != ids[wantIndex] {
					t.Errorf("%s: position %d: expected %s, got %s", tc.step, i, p.deploymentRef(ids[wantIndex]), p.deploymentRef(list[i].ID))
				}
				if list[i].Label != seeds[wantIndex].label {
					t.Errorf("%s: position %d: expected label %q, got %q", tc.step, i, seeds[wantIndex].label, list[i].Label)
				}
			}
		}

		p.record(tc.step, p.listFacts(list, total), nil)
	}
}

// assertUpdateReturnsStored checks that an update returns the same record a
// fresh read produces, minus timestamps.
func (p *parityProbe) assertUpdateReturnsStored(step string, returned *contract.TrackedContract, userID, contractID int64) {
	p.t.Helper()

	if returned == nil {
		p.t.Fatalf("%s: expected the updated tracking, got nil", step)
	}

	stored, err := p.repo.GetTracking(p.ctx, userID, contractID)
	if err != nil {
		p.t.Fatalf("%s: read back the stored tracking: %v", step, err)
	}
	if stored == nil {
		p.t.Fatalf("%s: expected the stored tracking, got nil", step)
	}

	if returned.ID != stored.ID || returned.Address != stored.Address || returned.ChainID != stored.ChainID ||
		returned.StartBlock != stored.StartBlock || returned.Label != stored.Label || returned.Enabled != stored.Enabled {
		p.t.Errorf("%s: returned record differs from the stored record:\nreturned: %s\nstored:   %s",
			step, p.trackingFacts(returned), p.trackingFacts(stored))
	}
	// CreatedAt is never part of parity (Go clock vs NOW()) but it must be
	// reported and must not move on update.
	if returned.CreatedAt.IsZero() || !returned.CreatedAt.Equal(stored.CreatedAt) {
		p.t.Errorf("%s: expected an unchanged createdAt, returned=%v stored=%v", step, returned.CreatedAt, stored.CreatedAt)
	}
}

func parityErrName(err error) string {
	switch {
	case err == nil:
		return "nil"
	case errors.Is(err, contract.ErrContractNotFound):
		return "ErrContractNotFound"
	case errors.Is(err, contract.ErrAlreadyTracked):
		return "ErrAlreadyTracked"
	default:
		return fmt.Sprintf("unexpected(%v)", err)
	}
}

func formatParityObservations(observations []parityObservation) string {
	var b strings.Builder
	for _, o := range observations {
		fmt.Fprintf(&b, "\n  %-36s err=%-19s got=%s", o.Step, o.Err, o.Got)
	}
	if b.Len() == 0 {
		return " <none>"
	}
	return b.String()
}

// parityAddress builds a 42-character address from a small numeric seed so each
// scenario owns a distinct deployment without hand-written literals.
func parityAddress(seed int64) string {
	return fmt.Sprintf("0x%040x", seed)
}

// parityAddressWithTail builds an address whose hex tail is readable, for the
// address-search case.
func parityAddressWithTail(tail string) string {
	return "0x" + strings.Repeat("0", 40-len(tail)) + tail
}

func parityMixedCase(address string) string {
	return "0x" + strings.ToUpper(address[2:])
}

func seedParityUsers(t *testing.T, db *sql.DB, count int) parityUsers {
	t.Helper()

	ids := make([]int64, count)
	for i := range ids {
		email := fmt.Sprintf("contract-parity-%d-%d@example.com", time.Now().UnixNano(), i)
		if err := db.QueryRowContext(t.Context(), `
			INSERT INTO users (email, password_hash)
			VALUES ($1, $2)
			RETURNING id
		`, email, "not-used-by-contract-parity-tests").Scan(&ids[i]); err != nil {
			t.Fatalf("seed parity user %d: %v", i, err)
		}

		userID := ids[i]
		t.Cleanup(func() {
			if _, err := db.ExecContext(context.Background(), "DELETE FROM users WHERE id = $1", userID); err != nil {
				t.Errorf("clean up parity user %d: %v", userID, err)
			}
		})
	}

	return parityUsers{
		owner:       ids[0],
		stranger:    ids[1],
		firstOfTwo:  ids[2],
		secondOfTwo: ids[3],
		lister:      ids[4],
	}
}

// assertParityDeploymentCount backs scenario A's "exactly one deployment" claim
// with a row count, which the Repository interface cannot express.
func assertParityDeploymentCount(t *testing.T, db *sql.DB, chainID int64, address string, want int) {
	t.Helper()

	var got int
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*)
		FROM contracts
		WHERE chain_id = $1 AND address = $2
	`, chainID, address).Scan(&got); err != nil {
		t.Fatalf("count deployments for scenario A: %v", err)
	}
	if got != want {
		t.Errorf("scenario A: expected %d deployment row for chain %d address %s, got %d", want, chainID, address, got)
	}
}
