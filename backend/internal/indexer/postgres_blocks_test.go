package indexer

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/evm"
)

// indexerTestBlockRows lists the stored canonical block rows of one contract
// oldest first.
func indexerTestBlockRows(t *testing.T, db *sql.DB, contractID int64) []string {
	t.Helper()

	return indexerTestRows(t, db, `
		SELECT block_number::text, block_hash, parent_hash
		FROM indexed_blocks
		WHERE contract_id = $1
		ORDER BY block_number
	`, contractID, 3)
}

func TestPostgresIndexer_ListIndexedBlocksWindow(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000181", 100)
	otherID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000191", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}
	if _, err := repo.EnsureCheckpoint(ctx, otherID); err != nil {
		t.Fatalf("ensure second checkpoint: %v", err)
	}
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 129, nil)); err != nil {
		t.Fatalf("commit first contract range: %v", err)
	}
	if _, err := repo.CommitRange(ctx, testRangeCommit(otherID, 100, 104, nil)); err != nil {
		t.Fatalf("commit second contract range: %v", err)
	}

	t.Run("full window newest first", func(t *testing.T) {
		headers, err := repo.ListIndexedBlocks(ctx, contractID, 100, 129)
		if err != nil {
			t.Fatalf("ListIndexedBlocks() = %v, want nil", err)
		}
		if len(headers) != 30 {
			t.Fatalf("rows = %d, want the whole committed range", len(headers))
		}
		if headers[0].BlockNumber != 129 || headers[len(headers)-1].BlockNumber != 100 {
			t.Errorf("order = %d..%d, want 129 down to 100", headers[0].BlockNumber, headers[len(headers)-1].BlockNumber)
		}
		for i := 1; i < len(headers); i++ {
			if headers[i].BlockNumber >= headers[i-1].BlockNumber {
				t.Fatalf("rows are not descending at position %d: %d then %d", i, headers[i-1].BlockNumber, headers[i].BlockNumber)
			}
		}
		want := BlockHeader{BlockNumber: 129, BlockHash: hashFor(129, 1), ParentHash: hashFor(128, 1)}
		if headers[0] != want {
			t.Errorf("newest row = %+v, want %+v", headers[0], want)
		}
	})

	t.Run("inclusive sub window", func(t *testing.T) {
		headers, err := repo.ListIndexedBlocks(ctx, contractID, 110, 112)
		if err != nil {
			t.Fatalf("ListIndexedBlocks() = %v, want nil", err)
		}
		want := []int64{112, 111, 110}
		if len(headers) != len(want) {
			t.Fatalf("rows = %d, want %d", len(headers), len(want))
		}
		for i, number := range want {
			if headers[i].BlockNumber != number {
				t.Errorf("row %d = %d, want %d", i, headers[i].BlockNumber, number)
			}
		}
	})

	t.Run("empty window is not an error", func(t *testing.T) {
		headers, err := repo.ListIndexedBlocks(ctx, contractID, 200, 210)
		if err != nil {
			t.Fatalf("ListIndexedBlocks() = %v, want nil for a window with no stored rows", err)
		}
		if len(headers) != 0 {
			t.Errorf("rows = %+v, want none", headers)
		}
	})

	t.Run("reads stay scoped to one contract", func(t *testing.T) {
		headers, err := repo.ListIndexedBlocks(ctx, otherID, 100, 129)
		if err != nil {
			t.Fatalf("ListIndexedBlocks() = %v, want nil", err)
		}
		if len(headers) != 5 {
			t.Fatalf("rows = %d, want only the second contract's 5 rows", len(headers))
		}
		for _, header := range headers {
			if header.BlockNumber > 104 {
				t.Errorf("row %d belongs to the other contract", header.BlockNumber)
			}
		}
	})
}

func TestPostgresIndexer_ListIndexedBlocksValidation(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000001a1", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 101, nil)); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	cases := map[string]struct {
		contractID int64
		fromBlock  int64
		toBlock    int64
		wantField  string
	}{
		"zero contract":     {contractID: 0, fromBlock: 100, toBlock: 100, wantField: "contractId"},
		"negative contract": {contractID: -1, fromBlock: 100, toBlock: 100, wantField: "contractId"},
		"negative start":    {contractID: contractID, fromBlock: -1, toBlock: 100, wantField: "fromBlock"},
		"inverted window":   {contractID: contractID, fromBlock: 200, toBlock: 100, wantField: "toBlock"},
		"over the cap":      {contractID: contractID, fromBlock: 100, toBlock: 200, wantField: "toBlock"},
	}

	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			headers, err := repo.ListIndexedBlocks(ctx, tt.contractID, tt.fromBlock, tt.toBlock)
			if err == nil {
				t.Fatalf("ListIndexedBlocks() = %+v, want a validation error", headers)
			}
			var validation ValidationError
			if !errors.As(err, &validation) {
				t.Fatalf("error %v, want a ValidationError", err)
			}
			if validation.Field != tt.wantField {
				t.Errorf("field = %q, want %q", validation.Field, tt.wantField)
			}
		})
	}

	// The cap is inclusive: a window of exactly maxIndexedBlockWindow blocks is
	// accepted, which is the size the reorg walk depends on.
	if _, err := repo.ListIndexedBlocks(ctx, contractID, 100, 199); err != nil {
		t.Errorf("a window at the cap was rejected: %v", err)
	}
}

func TestPostgresIndexer_ReinclusionOnANewBlockAfterRewind(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	startBlock := int64(200)
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000001b1", startBlock)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	// The original fork: a submit at 200 and the execute that follows it at 201.
	submit, err := NewSubmitTransactionEvent(contractID, EventMetadata{
		BlockNumber: 200, BlockHash: hashFor(200, 1), TransactionHash: reIncludedTxHash,
		TransactionIndex: 0, LogIndex: 0,
	}, indexerTestOwner, 1, "0x000000000000000000000000000000000000dead", mustUint256(t, "77"), nil)
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	execute := testOwnerEvent(t, contractID, EventExecuteTransaction, 201, hashFor(201, 1), 0, 1)
	execute.TransactionHash = reIncludedTxHash
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 200, 201, []Event{submit, execute})); err != nil {
		t.Fatalf("commit the original fork: %v", err)
	}
	if !indexerTestSingleBool(t, db, `
		SELECT executed FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = 1
	`, contractID) {
		t.Fatal("expected the transaction to be executed on the original fork")
	}

	// The fork is discarded, then the same transaction is included again in a
	// different block on the chain that replaced it.
	if _, err := repo.RewindToAncestor(ctx, contractID, 200); err != nil {
		t.Fatalf("rewind to ancestor: %v", err)
	}
	if indexerTestSingleBool(t, db, `
		SELECT executed FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = 1
	`, contractID) {
		t.Error("the rewind must rebuild projections from the events that remain canonical")
	}

	reincluded := testOwnerEvent(t, contractID, EventExecuteTransaction, 202, hashFor(202, 1), 0, 1)
	reincluded.TransactionHash = reIncludedTxHash
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 201, 202, []Event{reincluded})); err != nil {
		t.Fatalf("commit the re-included transaction: %v", err)
	}

	// One occurrence of the transaction, in its new block, with the orphaned row
	// kept as history.
	if got := indexerTestCount(t, db, "contract_events", contractID); got != 3 {
		t.Errorf("event rows = %d, want the two original rows plus the re-inclusion", got)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed"); got != 1 {
		t.Errorf("removed rows = %d, want the orphaned execution kept as history", got)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed = FALSE AND event_name = 'ExecuteTransaction'"); got != 1 {
		t.Errorf("canonical executions = %d, want exactly one", got)
	}
	if got := indexerTestCount(t, db, "multisig_transactions", contractID); got != 1 {
		t.Errorf("projected transactions = %d, want one occurrence", got)
	}
	if !indexerTestSingleBool(t, db, `
		SELECT executed FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = 1
	`, contractID) {
		t.Error("expected the re-included execution to be projected")
	}

	canonical := indexerTestRows(t, db, `
		SELECT block_number::text, block_hash
		FROM contract_events
		WHERE contract_id = $1 AND removed = FALSE AND event_name = 'ExecuteTransaction'
	`, contractID, 2)
	if len(canonical) != 1 {
		t.Fatalf("canonical executions = %v, want one row", canonical)
	}
	if !strings.HasPrefix(canonical[0], "202|"+hashFor(202, 1)) {
		t.Errorf("canonical execution = %q, want it stored at block 202 with the new hash", canonical[0])
	}

	if got := indexerTestBlockRows(t, db, contractID); len(got) != 3 {
		t.Errorf("canonical block rows = %v, want blocks 200, 201 and 202", got)
	}

	// A rebuild derives the same state from the canonical events alone.
	before := indexerTestTransactionState(t, db, contractID)
	if err := repo.RebuildProjections(ctx, contractID); err != nil {
		t.Fatalf("rebuild projections: %v", err)
	}
	if after := indexerTestTransactionState(t, db, contractID); len(after) != len(before) {
		t.Errorf("rebuild changed the projection:\nbefore %v\nafter  %v", before, after)
	}
}

// TestIndexerScanner_ReorgRewindsAndRescansAgainstTheDatabase drives the whole
// scanner against real rows: the stored tip loses its canonical match, the walk
// finds the fork, the repository rewinds, and the same tick rescans the
// replaced blocks.
func TestIndexerScanner_ReorgRewindsAndRescansAgainstTheDatabase(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	startBlock := int64(100)
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, scannerTestAddress, startBlock)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	// Phase one: the endpoint serves one chain, and confirmation plus execution
	// are indexed from it.
	confirm := scannerOwnerLog(t, EventConfirmTransaction, 101, 1, 0)
	confirm.BlockHash = hashFor(101, 1)
	execute := scannerOwnerLog(t, EventExecuteTransaction, 104, 1, 0)
	execute.BlockHash = hashFor(104, 1)

	reader := &scannerReader{latestBlock: 115, logs: []evm.RawLog{confirm, execute}}
	reader.canonicalHash = func(number uint64) string { return hashFor(int64(number), 1) }

	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(ctx); err != nil {
		t.Fatalf("first run: %v", err)
	}

	checkpoint, err := repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint: %v", err)
	}
	if checkpoint.NextBlock != 105 || checkpoint.LastIndexedBlock == nil || *checkpoint.LastIndexedBlock != 104 {
		t.Fatalf("checkpoint after the first run = %+v, want next block 105 with tip 104", checkpoint)
	}
	if got := indexerTestBlockRows(t, db, contractID); len(got) != 5 {
		t.Fatalf("canonical block rows = %v, want the five committed blocks", got)
	}

	// Phase two: blocks 103 and 104 are replaced, and the execution is included
	// again in the new block 104.
	reincluded := scannerOwnerLog(t, EventExecuteTransaction, 104, 1, 1)
	reincluded.BlockHash = hashFor(104, 2)
	reader.logs = []evm.RawLog{reincluded}
	reader.canonicalHash = func(number uint64) string {
		if number >= 103 {
			return hashFor(int64(number), 2)
		}
		return hashFor(int64(number), 1)
	}

	if err := job.Run(ctx); err != nil {
		t.Fatalf("second run: %v", err)
	}

	checkpoint, err = repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint after the reorg: %v", err)
	}
	if checkpoint.NextBlock != 105 {
		t.Errorf("next block = %d, want the rescan to have restored it to 105", checkpoint.NextBlock)
	}
	if checkpoint.LastIndexedBlock == nil || *checkpoint.LastIndexedBlock != 104 {
		t.Errorf("last indexed block = %v, want 104", checkpoint.LastIndexedBlock)
	}
	if checkpoint.LastIndexedBlockHash == nil || *checkpoint.LastIndexedBlockHash != hashFor(104, 2) {
		t.Errorf("last indexed hash = %v, want the replaced chain's block 104", checkpoint.LastIndexedBlockHash)
	}
	if checkpoint.Status != StatusIdle {
		t.Errorf("status = %q, want idle at the safe head", checkpoint.Status)
	}

	// The canonical rows are the replaced chain's, and the orphaned execution is
	// kept as history rather than deleted.
	rows := indexerTestBlockRows(t, db, contractID)
	if len(rows) != 5 {
		t.Fatalf("canonical block rows = %v, want five", rows)
	}
	if !strings.HasPrefix(rows[3], "103|"+hashFor(103, 2)) || !strings.HasPrefix(rows[4], "104|"+hashFor(104, 2)) {
		t.Errorf("replaced rows = %q and %q, want the new chain's hashes", rows[3], rows[4])
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed"); got != 1 {
		t.Errorf("removed rows = %d, want the orphaned execution kept as history", got)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed = FALSE AND event_name = 'ExecuteTransaction'"); got != 1 {
		t.Errorf("canonical executions = %d, want exactly one", got)
	}
	if got := indexerTestCount(t, db, "multisig_transactions", contractID); got != 1 {
		t.Errorf("projected transactions = %d, want one occurrence", got)
	}
	if !indexerTestSingleBool(t, db, `
		SELECT executed AND execute_block_number = 104
		FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = 1
	`, contractID) {
		t.Error("expected the re-included execution to be projected at block 104")
	}
	if got := indexerTestConfirmationState(t, db, contractID); len(got) != 1 {
		t.Errorf("confirmation rows = %v, want the untouched confirmation of block 101", got)
	}
}

// TestPostgresIndexer_RewindRollsBackWhenItFails holds a projected row from a
// second session so the rewind's projection rebuild cannot finish, and asserts
// that the whole rewind rolled back: events, block rows, projections and the
// checkpoint are exactly as they were.
func TestPostgresIndexer_RewindRollsBackWhenItFails(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000001c1", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}
	confirm := testConfirmEvent(t, contractID, 101, hashFor(101, 1), 0)
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 101, []Event{confirm})); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	eventsBefore := indexerTestCount(t, db, "contract_events", contractID)
	removedBefore := indexerTestCountWhere(t, db, "contract_events", contractID, "removed")
	blocksBefore := indexerTestBlockRows(t, db, contractID)
	stateBefore := indexerTestTransactionState(t, db, contractID)
	confirmationsBefore := indexerTestConfirmationState(t, db, contractID)
	checkpointBefore, err := repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint: %v", err)
	}

	// One session holds the projected row the rewind has to replace.
	blocker, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin blocking transaction: %v", err)
	}
	var blockedID int64
	if err := blocker.QueryRowContext(ctx, `
		SELECT id FROM multisig_transactions WHERE contract_id = $1 FOR UPDATE
	`, contractID).Scan(&blockedID); err != nil {
		blocker.Rollback()
		t.Fatalf("lock the projected row: %v", err)
	}

	rewindCtx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	if _, err := repo.RewindToAncestor(rewindCtx, contractID, 100); err == nil {
		blocker.Rollback()
		t.Fatal("RewindToAncestor() = nil, want the blocked rewind to fail")
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatalf("release the blocked row: %v", err)
	}

	if got := indexerTestCount(t, db, "contract_events", contractID); got != eventsBefore {
		t.Errorf("event rows = %d, want %d", got, eventsBefore)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed"); got != removedBefore {
		t.Errorf("removed rows = %d, want %d: the failed rewind must not keep its writes", got, removedBefore)
	}
	if got := indexerTestBlockRows(t, db, contractID); !slicesEqual(got, blocksBefore) {
		t.Errorf("block rows = %v, want %v", got, blocksBefore)
	}
	if got := indexerTestTransactionState(t, db, contractID); !slicesEqual(got, stateBefore) {
		t.Errorf("transaction projections = %v, want %v", got, stateBefore)
	}
	if got := indexerTestConfirmationState(t, db, contractID); !slicesEqual(got, confirmationsBefore) {
		t.Errorf("confirmations = %v, want %v", got, confirmationsBefore)
	}

	checkpointAfter, err := repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint after the failed rewind: %v", err)
	}
	if checkpointAfter.NextBlock != checkpointBefore.NextBlock {
		t.Errorf("next block = %d, want %d", checkpointAfter.NextBlock, checkpointBefore.NextBlock)
	}
	if checkpointAfter.Status != checkpointBefore.Status {
		t.Errorf("status = %q, want %q", checkpointAfter.Status, checkpointBefore.Status)
	}
}

// slicesEqual compares two string slices element by element.
func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
