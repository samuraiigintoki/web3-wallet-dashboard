package integration

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/big"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/indexer"
)

// TestRestartableFlow runs the Week 6 indexer as one system: a deployment
// created through the API, scanned into PostgreSQL, resumed after a restart,
// and corrected after the chain is rewritten underneath the stored tip. Every
// phase asserts against the same three layers a reviewer would check by hand:
// the event rows, the projections, and the HTTP answer.
func TestRestartableFlow(t *testing.T) {
	ctx := t.Context()
	db := setupFlowDatabase(t)
	repo := indexer.NewPostgresRepository(db)
	store := &flowStore{t: t, db: db}

	chain := newFakeChain(t)
	chain.setTip(flowLatestBlock)

	// The multisig story: one transaction submitted and confirmed twice, then
	// executed. The transaction and log indexes vary, so ordering is asserted
	// and not just the row count.
	submitValue := big.NewInt(1_000_000_000_000_000_000)
	chain.add(canonicalBranch, 1010, flowEvent{
		name: "SubmitTransaction", owner: flowOwnerA, multisigTxIndex: 1,
		to: flowRecipient, valueWei: submitValue, data: []byte{0xde, 0xad, 0xbe, 0xef},
		transactionIndex: 0, logIndex: 0,
	})
	chain.add(canonicalBranch, 1011, flowEvent{
		name: "ConfirmTransaction", owner: flowOwnerA, multisigTxIndex: 1,
		transactionIndex: 0, logIndex: 1,
	})
	chain.add(canonicalBranch, 1105, flowEvent{
		name: "ConfirmTransaction", owner: flowOwnerB, multisigTxIndex: 1,
		transactionIndex: 2, logIndex: 5,
	})
	chain.add(canonicalBranch, 1230, flowEvent{
		name: "ExecuteTransaction", owner: flowOwnerA, multisigTxIndex: 1,
		transactionIndex: 4, logIndex: 1,
	})

	api := newFlowAPI(t, db, repo)
	token := api.token("week6-flow@example.com")

	deployment := api.track(token, flowStartBlock)
	contractID := deployment.ID
	if deployment.IndexingStatus != "pending" {
		t.Fatalf("new deployment reports indexingStatus %q, want pending", deployment.IndexingStatus)
	}

	// ---------------------------------------------------------------------
	// Phase 1: start, scan into PostgreSQL, catch up to the safe head.
	// ---------------------------------------------------------------------
	scanner := newScannerRun(t, repo, chain)
	checkpoint := scanner.drain(ctx, contractID)

	safeHead := flowLatestBlock - (safeHeadConfirmations - 1)
	assertCommittedRanges(t, scanner, [][2]int64{
		{flowStartBlock, 1099},
		{1100, 1199},
		{1200, safeHead},
	})
	assertCheckpoint(t, checkpoint, indexer.StatusIdle, safeHead+1, safeHead, chain.canonicalHash(safeHead))

	if blocks := store.blockRows(t, contractID, flowStartBlock, safeHead); len(blocks) != int(safeHead-flowStartBlock+1) {
		t.Fatalf("indexed_blocks holds %d rows, want one per scanned height %d..%d", len(blocks), flowStartBlock, safeHead)
	}
	for _, block := range store.blockRows(t, contractID, flowStartBlock, safeHead) {
		if block.BlockHash != chain.canonicalHash(block.BlockNumber) {
			t.Fatalf("stored block %d carries hash %s, the canonical chain serves %s",
				block.BlockNumber, block.BlockHash, chain.canonicalHash(block.BlockNumber))
		}
	}

	canonical := store.canonicalEvents(t, contractID)
	assertEventRows(t, canonical, expectedCanonicalEvents(t, chain, flowStartBlock, safeHead))
	if removed := store.removedEvents(t, contractID); len(removed) != 0 {
		t.Fatalf("a scan on a chain with no reorganization left %d removed rows: %+v", len(removed), removed)
	}

	assertTransaction(t, store, contractID, transactionRow{
		multisigTxIndex:    "1",
		toAddress:          flowRecipient,
		valueWei:           submitValue.String(),
		callData:           "0xdeadbeef",
		executed:           true,
		submittedBy:        flowOwnerA,
		submitBlockNumber:  1010,
		executeBlockNumber: 1230,
		executeEVMHash:     chain.transactionHash(canonicalBranch, 1230, 4),
		submitEVMHash:      chain.transactionHash(canonicalBranch, 1010, 0),
	})
	assertConfirmations(t, store, contractID, map[string]confirmationRow{
		flowOwnerA: {confirmed: true, blockNumber: 1011, revokedBlockNumber: -1},
		flowOwnerB: {confirmed: true, blockNumber: 1105, revokedBlockNumber: -1},
	})

	envelope, raw := api.events(token, contractID, "1", "20")
	assertEventPage(t, envelope, raw, 20, []eventExpectation{
		{name: "ExecuteTransaction", blockNumber: 1230},
		{name: "ConfirmTransaction", blockNumber: 1105},
		{name: "ConfirmTransaction", blockNumber: 1011},
		{name: "SubmitTransaction", blockNumber: 1010},
	})
	firstEvent := envelope.Data[0]
	if firstEvent.MultisigTxIndex != "1" || firstEvent.LogIndex != 1 {
		t.Fatalf("newest event carries index %q and log %d, want 1 and 1", firstEvent.MultisigTxIndex, firstEvent.LogIndex)
	}
	submitEvent := envelope.Data[3]
	if submitEvent.ActorAddress != flowOwnerA {
		t.Errorf("submit actor = %s, want %s", submitEvent.ActorAddress, flowOwnerA)
	}
	var submitPayload struct {
		To       string `json:"to"`
		ValueWei string `json:"valueWei"`
		Data     string `json:"data"`
	}
	if err := json.Unmarshal(submitEvent.Payload, &submitPayload); err != nil {
		t.Fatalf("decode submit payload %s: %v", submitEvent.Payload, err)
	}
	if submitPayload.To != flowRecipient || submitPayload.ValueWei != submitValue.String() || submitPayload.Data != "0xdeadbeef" {
		t.Errorf("submit payload = %+v, want the exact wei value and 0x calldata", submitPayload)
	}

	// ---------------------------------------------------------------------
	// Phase 2: stop mid range, restart, resume from the checkpoint.
	// ---------------------------------------------------------------------
	beforeRestart := store.canonicalEvents(t, contractID)
	beforeRows := len(beforeRestart)

	// A process killed during a range leaves the status it wrote at the start
	// of that range and nothing else: the commit that would have advanced the
	// checkpoint never happened.
	if _, err := repo.SetCheckpointStatus(ctx, contractID, indexer.StatusRunning, ""); err != nil {
		t.Fatalf("leave a stale running status: %v", err)
	}
	stale, err := repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint: %v", err)
	}
	if stale.Status != indexer.StatusRunning || stale.NextBlock != safeHead+1 {
		t.Fatalf("stale checkpoint = %s at %d, want running at %d", stale.Status, stale.NextBlock, safeHead+1)
	}

	// The chain moves on while the process is down.
	chain.setTip(flowResumedTip)
	chain.add(canonicalBranch, 1280, flowEvent{
		name: "RevokeConfirmation", owner: flowOwnerB, multisigTxIndex: 1,
		transactionIndex: 1, logIndex: 0,
	})
	resumedSafeHead := flowResumedTip - (safeHeadConfirmations - 1)

	// Restart does what cmd/api does after its endpoint check: clear stale
	// running checkpoints, then build the scanner again.
	reset, err := repo.ResetRunningCheckpoints(ctx)
	if err != nil {
		t.Fatalf("reset stale checkpoints: %v", err)
	}
	if reset != 1 {
		t.Fatalf("startup reset %d checkpoints, want the one left running", reset)
	}
	resumed := newScannerRun(t, repo, chain)
	checkpoint = resumed.drain(ctx, contractID)
	// The resume covers exactly the range the checkpoint pointed at, so the
	// range already committed above the old tip is never scanned twice.
	assertCommittedRanges(t, resumed, [][2]int64{{safeHead + 1, resumedSafeHead}})
	assertCheckpoint(t, checkpoint, indexer.StatusIdle, resumedSafeHead+1, resumedSafeHead, chain.canonicalHash(resumedSafeHead))

	if duplicates := store.duplicateEvents(t, contractID); duplicates != 0 {
		t.Fatalf("resume produced %d duplicate event rows, want none", duplicates)
	}
	afterRestart := store.canonicalEvents(t, contractID)
	if len(afterRestart) != beforeRows+1 {
		t.Fatalf("canonical events = %d after resume, want %d", len(afterRestart), beforeRows+1)
	}
	if !reflect.DeepEqual(afterRestart[:beforeRows], beforeRestart) {
		t.Errorf("resume changed the events written before the restart\n before: %+v\n after:  %+v", beforeRestart, afterRestart[:beforeRows])
	}

	// A second pass over a chain that has not moved must not write anything.
	beforeIdle := store.allEvents(t, contractID)
	idle := newScannerRun(t, repo, chain)
	for pass := 0; pass < 3; pass++ {
		idle.runOnce(ctx)
	}
	if afterIdle := store.allEvents(t, contractID); !reflect.DeepEqual(afterIdle, beforeIdle) {
		t.Errorf("replaying a caught-up chain changed the event rows\n before: %+v\n after:  %+v", beforeIdle, afterIdle)
	}
	if checkpoint := scanner.checkpoint(t, contractID); checkpoint.Status != indexer.StatusIdle || checkpoint.NextBlock != resumedSafeHead+1 {
		t.Errorf("caught-up checkpoint = %s at %d, want idle at %d", checkpoint.Status, checkpoint.NextBlock, resumedSafeHead+1)
	}

	assertConfirmations(t, store, contractID, map[string]confirmationRow{
		flowOwnerA: {confirmed: true, blockNumber: 1011, revokedBlockNumber: -1},
		flowOwnerB: {confirmed: false, blockNumber: 1105, revokedBlockNumber: 1280},
	})
	assertTransaction(t, store, contractID, transactionRow{
		multisigTxIndex:    "1",
		toAddress:          flowRecipient,
		valueWei:           submitValue.String(),
		callData:           "0xdeadbeef",
		executed:           true,
		submittedBy:        flowOwnerA,
		submitBlockNumber:  1010,
		executeBlockNumber: 1230,
		executeEVMHash:     chain.transactionHash(canonicalBranch, 1230, 4),
		submitEVMHash:      chain.transactionHash(canonicalBranch, 1010, 0),
	})

	envelope, raw = api.events(token, contractID, "1", "100")
	assertEventPage(t, envelope, raw, 100, []eventExpectation{
		{name: "RevokeConfirmation", blockNumber: 1280},
		{name: "ExecuteTransaction", blockNumber: 1230},
		{name: "ConfirmTransaction", blockNumber: 1105},
		{name: "ConfirmTransaction", blockNumber: 1011},
		{name: "SubmitTransaction", blockNumber: 1010},
	})

	// ---------------------------------------------------------------------
	// Phase 3: rewrite the chain under the stored tip and correct the state.
	// ---------------------------------------------------------------------
	stableEvents := store.canonicalEvents(t, contractID, flowStartBlock, flowForkHeight-1)
	stableBlocks := store.blockRows(t, contractID, flowStartBlock, flowForkHeight-1)
	abandoned := store.canonicalEvents(t, contractID, flowForkHeight, resumedSafeHead)
	if len(abandoned) != 3 {
		t.Fatalf("the abandoned branch held %d events, want the confirm, the execute and the revoke", len(abandoned))
	}

	// The replacement branch: a different confirmation at a different height,
	// an execution at a later block, and no revocation at all.
	chain.forkFrom(flowForkHeight)
	chain.add(forkBranch, 1060, flowEvent{
		name: "ConfirmTransaction", owner: flowOwnerB, multisigTxIndex: 1,
		transactionIndex: 2, logIndex: 0,
	})
	chain.add(forkBranch, 1240, flowEvent{
		name: "ExecuteTransaction", owner: flowOwnerA, multisigTxIndex: 1,
		transactionIndex: 0, logIndex: 1,
	})

	// One run detects the mismatch at the stored tip, walks the stored rows to
	// the common ancestor, rewinds and rescans from the ancestor onwards.
	reorg := newScannerRun(t, repo, chain)
	reorg.runOnce(ctx)
	if !strings.Contains(reorg.logOutput(), "rewound a contract to the common ancestor") {
		t.Fatalf("the run did not report a rewind, its log was:\n%s", reorg.logOutput())
	}
	checkpoint = reorg.drain(ctx, contractID)

	assertCommittedRanges(t, reorg, [][2]int64{
		{flowForkHeight, 1149},
		{1150, 1249},
		{1250, resumedSafeHead},
	})
	if !strings.Contains(reorg.logOutput(), fmt.Sprintf("ancestorBlock=%d", flowForkHeight-1)) {
		t.Errorf("the rewind did not stop at the last common block %d, its log was:\n%s", flowForkHeight-1, reorg.logOutput())
	}
	assertCheckpoint(t, checkpoint, indexer.StatusIdle, resumedSafeHead+1, resumedSafeHead, chain.canonicalHash(resumedSafeHead))

	// Layer 1: events. Every canonical row matches the replacement branch, and
	// the abandoned branch is retained as history rather than deleted.
	canonical = store.canonicalEvents(t, contractID, flowStartBlock, resumedSafeHead)
	assertEventRows(t, canonical, expectedCanonicalEvents(t, chain, flowStartBlock, resumedSafeHead))

	removed := store.removedEvents(t, contractID)
	if len(removed) != len(abandoned) {
		t.Fatalf("removed rows = %d, want the %d abandoned events retained as history", len(removed), len(abandoned))
	}
	removedByBlock := map[int64]storedEvent{}
	for _, event := range removed {
		removedByBlock[event.BlockNumber] = event
	}
	for _, event := range abandoned {
		kept, ok := removedByBlock[event.BlockNumber]
		if !ok {
			t.Fatalf("block %d event is neither canonical nor retained: %+v", event.BlockNumber, event)
		}
		if kept.BlockHash != event.BlockHash || kept.TransactionHash != event.TransactionHash {
			t.Errorf("retained row for block %d carries %s/%s, want the abandoned %s/%s",
				event.BlockNumber, kept.BlockHash, kept.TransactionHash, event.BlockHash, event.TransactionHash)
		}
		if stored := chain.canonicalHash(event.BlockNumber); kept.BlockHash == stored {
			t.Errorf("retained row for block %d still carries the canonical hash, it was not orphaned", event.BlockNumber)
		}
	}
	if duplicates := store.duplicateEvents(t, contractID); duplicates != 0 {
		t.Errorf("the reorganization produced %d duplicate event rows, want none", duplicates)
	}

	// The rows below the fork are untouched, and the block rows above it carry
	// the replacement hashes.
	if current := store.blockRows(t, contractID, flowStartBlock, flowForkHeight-1); !reflect.DeepEqual(current, stableBlocks) {
		t.Errorf("blocks below the fork changed\n before: %+v\n after:  %+v", stableBlocks, current)
	}
	blocks := store.blockRows(t, contractID, flowStartBlock, resumedSafeHead)
	if len(blocks) != int(resumedSafeHead-flowStartBlock+1) {
		t.Fatalf("indexed_blocks holds %d rows after the rescan, want %d", len(blocks), resumedSafeHead-flowStartBlock+1)
	}
	for _, block := range blocks {
		if block.BlockHash != chain.canonicalHash(block.BlockNumber) {
			t.Errorf("stored block %d carries %s after the rescan, the chain serves %s",
				block.BlockNumber, block.BlockHash, chain.canonicalHash(block.BlockNumber))
		}
	}
	if below := store.canonicalEvents(t, contractID, flowStartBlock, flowForkHeight-1); !reflect.DeepEqual(below, stableEvents) {
		t.Errorf("events below the fork changed\n before: %+v\n after:  %+v", stableEvents, below)
	}

	// Layer 2: projections are rebuilt from the corrected history, so the
	// execution the fork dropped is gone and the confirmation it moved is back.
	assertTransaction(t, store, contractID, transactionRow{
		multisigTxIndex:    "1",
		toAddress:          flowRecipient,
		valueWei:           submitValue.String(),
		callData:           "0xdeadbeef",
		executed:           true,
		submittedBy:        flowOwnerA,
		submitBlockNumber:  1010,
		executeBlockNumber: 1240,
		executeEVMHash:     chain.transactionHash(forkBranch, 1240, 0),
		submitEVMHash:      chain.transactionHash(canonicalBranch, 1010, 0),
	})
	assertConfirmations(t, store, contractID, map[string]confirmationRow{
		flowOwnerA: {confirmed: true, blockNumber: 1011, revokedBlockNumber: -1},
		flowOwnerB: {confirmed: true, blockNumber: 1060, revokedBlockNumber: -1},
	})

	// Layer 3: the API serves the corrected state and nothing else. The
	// reorganized events are simply absent from the page and from the total.
	envelope, raw = api.events(token, contractID, "1", "20")
	assertEventPage(t, envelope, raw, 20, []eventExpectation{
		{name: "ExecuteTransaction", blockNumber: 1240},
		{name: "ConfirmTransaction", blockNumber: 1060},
		{name: "ConfirmTransaction", blockNumber: 1011},
		{name: "SubmitTransaction", blockNumber: 1010},
	})
	for _, event := range envelope.Data {
		if event.BlockNumber == 1230 || event.BlockNumber == 1105 || event.BlockNumber == 1280 {
			t.Errorf("the page serves the abandoned event at block %d", event.BlockNumber)
		}
		if event.BlockHash != chain.canonicalHash(event.BlockNumber) {
			t.Errorf("event at block %d carries %s, the chain serves %s",
				event.BlockNumber, event.BlockHash, chain.canonicalHash(event.BlockNumber))
		}
	}
	if canonicalRows := store.countCanonicalEvents(t, contractID); canonicalRows != len(envelope.Data) {
		t.Errorf("contract_events holds %d canonical rows and the page holds %d, want totalItems to count the same rows",
			canonicalRows, len(envelope.Data))
	}
	if total, expected := store.countEvents(t, contractID), len(canonical)+len(removed); total != expected {
		t.Errorf("contract_events holds %d rows, want the %d canonical and %d retained rows",
			total, len(canonical), len(removed))
	}

	// The reorganization is an indexing event, not a configuration change: the
	// deployment's own answer is the same before and after it.
	if final := api.contract(token, contractID); final.IndexingStatus != deployment.IndexingStatus {
		t.Errorf("indexingStatus = %q after the reorganization, want the unchanged %q", final.IndexingStatus, deployment.IndexingStatus)
	}
}

// scannerRun is one scanner process: a job, the repository it reads and writes,
// and the log it produced, so a phase can assert that the path it meant to
// exercise was the path that ran.
type scannerRun struct {
	t    *testing.T
	job  *indexer.Job
	repo indexer.Repository
	logs *bytes.Buffer
}

func newScannerRun(t *testing.T, repo indexer.Repository, chain *fakeChain) *scannerRun {
	t.Helper()

	logs := &bytes.Buffer{}
	// The URL is empty: no request leaves this process, and the scanner's
	// redaction has nothing to redact.
	job, err := indexer.NewJob(repo, chain, flowChainID, "", slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err != nil {
		t.Fatalf("build scanner: %v", err)
	}
	return &scannerRun{t: t, job: job, repo: repo, logs: logs}
}

func (s *scannerRun) runOnce(ctx context.Context) {
	s.t.Helper()

	if err := s.job.Run(ctx); err != nil {
		s.t.Fatalf("scanner run failed: %v\nlog:\n%s", err, s.logOutput())
	}
}

// drain runs the scanner until it reports the contract caught up, which is the
// state a healthy process settles into between ticks.
func (s *scannerRun) drain(ctx context.Context, contractID int64) *indexer.Checkpoint {
	s.t.Helper()

	for attempt := 0; attempt < 20; attempt++ {
		if err := s.job.Run(ctx); err != nil {
			s.t.Fatalf("scanner run %d failed: %v\nlog:\n%s", attempt, err, s.logOutput())
		}
		checkpoint, err := s.repo.GetCheckpoint(ctx, contractID)
		if err != nil {
			s.t.Fatalf("read checkpoint: %v", err)
		}
		if checkpoint.Status == indexer.StatusIdle {
			return checkpoint
		}
	}
	s.t.Fatalf("scanner did not catch up after 20 runs\nlog:\n%s", s.logOutput())
	return nil
}

func (s *scannerRun) checkpoint(t *testing.T, contractID int64) *indexer.Checkpoint {
	t.Helper()

	checkpoint, err := s.repo.GetCheckpoint(t.Context(), contractID)
	if err != nil {
		t.Fatalf("read checkpoint: %v", err)
	}
	return checkpoint
}

func (s *scannerRun) logOutput() string { return s.logs.String() }

// committedRanges reads the ranges this process committed, in order, out of its
// own log. It is the assertion that a resume continued from the checkpoint and
// that a rewind resumed from the ancestor: a scanner that restarted from the
// start block, or that re-scanned a range it had already committed, reports a
// different list.
func (s *scannerRun) committedRanges(t *testing.T) [][2]int64 {
	t.Helper()

	var ranges [][2]int64
	for _, line := range strings.Split(s.logOutput(), "\n") {
		if !strings.Contains(line, "indexer range committed") {
			continue
		}
		from := committedRangeValue(t, line, "fromBlock=")
		to := committedRangeValue(t, line, "toBlock=")
		ranges = append(ranges, [2]int64{from, to})
	}
	return ranges
}

func committedRangeValue(t *testing.T, line, key string) int64 {
	t.Helper()

	index := strings.Index(line, key)
	if index < 0 {
		t.Fatalf("log line %q carries no %s field", line, key)
	}
	rest := line[index+len(key):]
	value, err := strconv.ParseInt(rest[:strings.IndexAny(rest+" ", " \"")], 10, 64)
	if err != nil {
		t.Fatalf("log line %q has a %s value that is not an integer: %v", line, key, err)
	}
	return value
}

func assertCommittedRanges(t *testing.T, run *scannerRun, want [][2]int64) {
	t.Helper()

	got := run.committedRanges(t)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("committed ranges = %v, want %v\nlog:\n%s", got, want, run.logOutput())
	}
}

// stored state readers ---------------------------------------------------------

type storedEvent struct {
	EventName        string
	BlockNumber      int64
	BlockHash        string
	TransactionHash  string
	TransactionIndex int
	LogIndex         int
	ActorAddress     string
	MultisigTxIndex  string
	Removed          bool
}

type storedBlock struct {
	BlockNumber int64
	BlockHash   string
	ParentHash  string
}

type transactionRow struct {
	multisigTxIndex    string
	toAddress          string
	valueWei           string
	callData           string
	executed           bool
	submittedBy        string
	submitEVMHash      string
	submitBlockNumber  int64
	executeEVMHash     string
	executeBlockNumber int64
}

type confirmationRow struct {
	confirmed          bool
	blockNumber        int64
	revokedBlockNumber int64
}

type flowStore struct {
	t  *testing.T
	db *sql.DB
}

const storedEventColumns = `event_name, block_number, block_hash, transaction_hash, transaction_index,
	       log_index, COALESCE(actor_address, ''), COALESCE(multisig_tx_index::text, ''), removed`

func (s *flowStore) scanEvents(query string, args ...any) []storedEvent {
	s.t.Helper()

	rows, err := s.db.QueryContext(s.t.Context(), query, args...)
	if err != nil {
		s.t.Fatalf("read events: %v", err)
	}
	defer rows.Close()

	var events []storedEvent
	for rows.Next() {
		var event storedEvent
		if err := rows.Scan(
			&event.EventName, &event.BlockNumber, &event.BlockHash, &event.TransactionHash,
			&event.TransactionIndex, &event.LogIndex, &event.ActorAddress, &event.MultisigTxIndex, &event.Removed,
		); err != nil {
			s.t.Fatalf("scan event row: %v", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		s.t.Fatalf("read event rows: %v", err)
	}
	return events
}

// canonicalEvents reads one contract's canonical rows in canonical order, which
// is the order the projections are rebuilt in and the reverse of what the API
// serves.
func (s *flowStore) canonicalEvents(t *testing.T, contractID int64, bounds ...int64) []storedEvent {
	t.Helper()

	query := `SELECT ` + storedEventColumns + ` FROM contract_events WHERE contract_id = $1 AND removed = FALSE`
	args := []any{contractID}
	if len(bounds) == 2 {
		query += ` AND block_number BETWEEN $2 AND $3`
		args = append(args, bounds[0], bounds[1])
	}
	query += ` ORDER BY block_number, transaction_index, log_index`
	return s.scanEvents(query, args...)
}

func (s *flowStore) allEvents(t *testing.T, contractID int64) []storedEvent {
	t.Helper()

	query := `SELECT ` + storedEventColumns + ` FROM contract_events WHERE contract_id = $1
		ORDER BY block_number, transaction_index, log_index, removed`
	return s.scanEvents(query, contractID)
}

func (s *flowStore) removedEvents(t *testing.T, contractID int64) []storedEvent {
	t.Helper()

	query := `SELECT ` + storedEventColumns + ` FROM contract_events WHERE contract_id = $1 AND removed = TRUE
		ORDER BY block_number, transaction_index, log_index`
	return s.scanEvents(query, contractID)
}

func (s *flowStore) countEvents(t *testing.T, contractID int64) int {
	t.Helper()

	var count int
	if err := s.db.QueryRowContext(t.Context(),
		`SELECT COUNT(*) FROM contract_events WHERE contract_id = $1`, contractID).Scan(&count); err != nil {
		t.Fatalf("count events: %v", err)
	}
	return count
}

// duplicateEvents counts rows that share the identity a replay would collide on.
// The schema's unique constraint should make this impossible; the flow asserts
// it because a resumed scan is exactly where a duplicate would be written.
// countCanonicalEvents counts the rows the API is allowed to serve.
func (s *flowStore) countCanonicalEvents(t *testing.T, contractID int64) int {
	t.Helper()

	var count int
	if err := s.db.QueryRowContext(t.Context(),
		`SELECT COUNT(*) FROM contract_events WHERE contract_id = $1 AND removed = FALSE`, contractID).Scan(&count); err != nil {
		t.Fatalf("count canonical events: %v", err)
	}
	return count
}

func (s *flowStore) duplicateEvents(t *testing.T, contractID int64) int {
	t.Helper()

	var duplicates int
	const query = `
		SELECT COUNT(*) FROM (
			SELECT 1 FROM contract_events WHERE contract_id = $1
			GROUP BY block_hash, log_index HAVING COUNT(*) > 1
		) duplicated
	`
	if err := s.db.QueryRowContext(t.Context(), query, contractID).Scan(&duplicates); err != nil {
		t.Fatalf("count duplicate events: %v", err)
	}
	return duplicates
}

func (s *flowStore) blockRows(t *testing.T, contractID, fromBlock, toBlock int64) []storedBlock {
	t.Helper()

	const query = `
		SELECT block_number, block_hash, parent_hash FROM indexed_blocks
		WHERE contract_id = $1 AND block_number BETWEEN $2 AND $3
		ORDER BY block_number
	`
	rows, err := s.db.QueryContext(t.Context(), query, contractID, fromBlock, toBlock)
	if err != nil {
		s.t.Fatalf("read indexed blocks: %v", err)
	}
	defer rows.Close()

	var blocks []storedBlock
	for rows.Next() {
		var block storedBlock
		if err := rows.Scan(&block.BlockNumber, &block.BlockHash, &block.ParentHash); err != nil {
			s.t.Fatalf("scan indexed block: %v", err)
		}
		blocks = append(blocks, block)
	}
	if err := rows.Err(); err != nil {
		s.t.Fatalf("read indexed block rows: %v", err)
	}
	return blocks
}

func (s *flowStore) transaction(t *testing.T, contractID int64, multisigTxIndex string) transactionRow {
	t.Helper()

	const query = `
		SELECT multisig_tx_index::text, COALESCE(to_address, ''), COALESCE(value_wei::text, ''),
		       COALESCE(encode(call_data, 'hex'), ''), executed, COALESCE(submitted_by, ''),
		       COALESCE(submit_evm_tx_hash, ''), COALESCE(submit_block_number, -1),
		       COALESCE(execute_evm_tx_hash, ''), COALESCE(execute_block_number, -1)
		FROM multisig_transactions
		WHERE contract_id = $1 AND multisig_tx_index = $2::numeric
	`
	row := transactionRow{}
	var callData string
	if err := s.db.QueryRowContext(t.Context(), query, contractID, multisigTxIndex).Scan(
		&row.multisigTxIndex, &row.toAddress, &row.valueWei, &callData, &row.executed, &row.submittedBy,
		&row.submitEVMHash, &row.submitBlockNumber, &row.executeEVMHash, &row.executeBlockNumber,
	); err != nil {
		s.t.Fatalf("read multisig transaction %s: %v", multisigTxIndex, err)
	}
	if callData != "" {
		row.callData = "0x" + callData
	}
	return row
}

func (s *flowStore) confirmations(t *testing.T, contractID int64) map[string]confirmationRow {
	t.Helper()

	const query = `
		SELECT owner_address, confirmed, COALESCE(confirmed_block_number, -1), COALESCE(revoked_block_number, -1)
		FROM transaction_confirmations
		WHERE multisig_transaction_id IN (SELECT id FROM multisig_transactions WHERE contract_id = $1)
	`
	rows, err := s.db.QueryContext(t.Context(), query, contractID)
	if err != nil {
		s.t.Fatalf("read confirmations: %v", err)
	}
	defer rows.Close()

	confirmations := map[string]confirmationRow{}
	for rows.Next() {
		var owner string
		var row confirmationRow
		if err := rows.Scan(&owner, &row.confirmed, &row.blockNumber, &row.revokedBlockNumber); err != nil {
			s.t.Fatalf("scan confirmation: %v", err)
		}
		confirmations[owner] = row
	}
	if err := rows.Err(); err != nil {
		s.t.Fatalf("read confirmation rows: %v", err)
	}
	return confirmations
}

// expected state -----------------------------------------------------------------

// expectedCanonicalEvents derives the rows the database must hold from the
// chain the scanner read, so an assertion compares the whole system against its
// input rather than against a second hand-written list.
func expectedCanonicalEvents(t *testing.T, chain *fakeChain, fromBlock, toBlock int64) []storedEvent {
	t.Helper()

	var events []storedEvent
	for number := fromBlock; number <= toBlock; number++ {
		branch := chain.branchAt(number)
		for _, planned := range chain.canonicalLogs(number) {
			events = append(events, storedEvent{
				EventName:        planned.name,
				BlockNumber:      number,
				BlockHash:        chain.blockHash(branch, number),
				TransactionHash:  chain.transactionHash(branch, number, planned.transactionIndex),
				TransactionIndex: planned.transactionIndex,
				LogIndex:         planned.logIndex,
				ActorAddress:     planned.owner,
				MultisigTxIndex:  fmt.Sprintf("%d", planned.multisigTxIndex),
				Removed:          false,
			})
		}
	}
	sort.Slice(events, func(i, j int) bool {
		if events[i].BlockNumber != events[j].BlockNumber {
			return events[i].BlockNumber < events[j].BlockNumber
		}
		if events[i].TransactionIndex != events[j].TransactionIndex {
			return events[i].TransactionIndex < events[j].TransactionIndex
		}
		return events[i].LogIndex < events[j].LogIndex
	})
	return events
}

type eventExpectation struct {
	name        string
	blockNumber int64
}

// assertEventPage checks the decoded page and the wire shape together: the
// newest-first order the route promises, the total that has to agree with the
// canonical history, and the absence of any removed row from the body.
func assertEventPage(t *testing.T, envelope httpapi.EventListEnvelope, raw map[string]any, pageSize int, want []eventExpectation) {
	t.Helper()

	if len(envelope.Data) != len(want) {
		t.Fatalf("page holds %d events, want %d: %+v", len(envelope.Data), len(want), envelope.Data)
	}
	if envelope.Pagination.TotalItems != int64(len(want)) {
		t.Errorf("totalItems = %d, want the %d canonical events", envelope.Pagination.TotalItems, len(want))
	}
	if envelope.Pagination.Page != 1 || envelope.Pagination.PageSize != pageSize {
		t.Errorf("pagination = page %d of size %d, want page 1 of the requested size %d",
			envelope.Pagination.Page, envelope.Pagination.PageSize, pageSize)
	}
	for i, expected := range want {
		event := envelope.Data[i]
		if event.EventName != expected.name || event.BlockNumber != expected.blockNumber {
			t.Errorf("event %d = %s at block %d, want %s at block %d",
				i, event.EventName, event.BlockNumber, expected.name, expected.blockNumber)
		}
	}
	if len(envelope.Data) > 1 {
		for i := 1; i < len(envelope.Data); i++ {
			previous, current := envelope.Data[i-1], envelope.Data[i]
			if previous.BlockNumber < current.BlockNumber {
				t.Errorf("event %d at block %d precedes block %d, want newest first", i, previous.BlockNumber, current.BlockNumber)
			}
		}
	}

	// The raw body is the other half of the contract: the page is a list of
	// events under data, and no other key leaked into the envelope.
	if _, ok := raw["data"]; !ok {
		t.Errorf("body has no data key: %v", raw)
	}
	if len(raw) != 2 {
		t.Errorf("body has %d top-level keys, want data and pagination: %v", len(raw), raw)
	}
}

func assertEventRows(t *testing.T, got, want []storedEvent) {
	t.Helper()

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stored events do not match the chain the scanner read\n got (%d): %+v\nwant (%d): %+v", len(got), got, len(want), want)
	}
}

func assertCheckpoint(t *testing.T, checkpoint *indexer.Checkpoint, status indexer.CheckpointStatus, nextBlock, lastIndexed int64, lastHash string) {
	t.Helper()

	if checkpoint.Status != status {
		t.Errorf("checkpoint status = %s, want %s", checkpoint.Status, status)
	}
	if checkpoint.NextBlock != nextBlock {
		t.Errorf("checkpoint next block = %d, want %d", checkpoint.NextBlock, nextBlock)
	}
	if checkpoint.LastIndexedBlock == nil || *checkpoint.LastIndexedBlock != lastIndexed {
		t.Errorf("checkpoint last indexed block = %v, want %d", checkpoint.LastIndexedBlock, lastIndexed)
	}
	if checkpoint.LastIndexedBlockHash == nil || *checkpoint.LastIndexedBlockHash != lastHash {
		t.Errorf("checkpoint last indexed hash = %v, want %s", checkpoint.LastIndexedBlockHash, lastHash)
	}
	if checkpoint.LastError != nil {
		t.Errorf("checkpoint carries error text %q, want none", *checkpoint.LastError)
	}
}

func assertTransaction(t *testing.T, store *flowStore, contractID int64, want transactionRow) {
	t.Helper()

	got := store.transaction(t, contractID, want.multisigTxIndex)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("projection = %+v, want %+v", got, want)
	}
}

func assertConfirmations(t *testing.T, store *flowStore, contractID int64, want map[string]confirmationRow) {
	t.Helper()

	got := store.confirmations(t, contractID)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("confirmations = %+v, want %+v", got, want)
	}
}
