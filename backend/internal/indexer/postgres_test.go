package indexer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/migrations"
)

// These integration tests are gated on DATABASE_URL and own a dedicated schema.
// internal/contract tests truncate the shared public tables and Go runs packages
// in parallel, so this suite builds its own schema from the embedded migrations
// and never touches public. Do not use t.Parallel: every test resets the schema
// tables it shares with the other tests in this file.

const (
	indexerTestSchema = "indexer_test"

	indexerTestChainSepolia int64 = 11155111
	indexerTestChainMainnet int64 = 1

	indexerTestOwner = "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746"

	// reIncludedTxHash is one transaction hash stored in two different blocks to
	// represent a fork re-inclusion.
	reIncludedTxHash = "0x0000000000000000000000000000000000000000000000000000000000000abc"
)

var (
	indexerTestSchemaOnce sync.Once
	indexerTestSchemaErr  error
)

func TestPostgresIndexer_MigrationShape(t *testing.T) {
	db, _ := setupPostgresIndexerTest(t)
	ctx := t.Context()

	wantTables := []string{"indexed_blocks", "contract_events", "multisig_transactions", "transaction_confirmations", "indexer_checkpoints"}
	for _, table := range wantTables {
		var exists bool
		if err := db.QueryRowContext(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM information_schema.tables
				WHERE table_schema = $1 AND table_name = $2
			)
		`, indexerTestSchema, table).Scan(&exists); err != nil {
			t.Fatalf("inspect table %s: %v", table, err)
		}
		if !exists {
			t.Errorf("expected table %s after migrations up", table)
		}
	}

	var indexExists bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM pg_indexes
			WHERE schemaname = $1 AND indexname = 'idx_contracts_chain_indexing_enabled'
		)
	`, indexerTestSchema).Scan(&indexExists); err != nil {
		t.Fatalf("inspect contracts index: %v", err)
	}
	if !indexExists {
		t.Error("expected the deferred watch-set index to exist after 0008")
	}
}

// TestPostgresIndexer_MigrationUpDownCycle runs the 0008 down file and then the
// up file inside one transaction and rolls it back. Both files must execute
// cleanly and the up file must restore exactly the objects the down file drops.
func TestPostgresIndexer_MigrationUpDownCycle(t *testing.T) {
	db, _ := setupPostgresIndexerTest(t)
	ctx := t.Context()

	down, err := migrations.FS.ReadFile("0008_create_indexer_tables.down.sql")
	if err != nil {
		t.Fatalf("read down migration: %v", err)
	}
	up, err := migrations.FS.ReadFile("0008_create_indexer_tables.up.sql")
	if err != nil {
		t.Fatalf("read up migration: %v", err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin migration cycle: %v", err)
	}
	defer tx.Rollback()

	tableExists := func(table string) bool {
		t.Helper()
		var exists bool
		if err := tx.QueryRowContext(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM information_schema.tables
				WHERE table_schema = $1 AND table_name = $2
			)
		`, indexerTestSchema, table).Scan(&exists); err != nil {
			t.Fatalf("inspect table %s: %v", table, err)
		}
		return exists
	}

	for _, table := range []string{"indexed_blocks", "contract_events", "multisig_transactions", "transaction_confirmations", "indexer_checkpoints"} {
		if !tableExists(table) {
			t.Fatalf("expected %s to exist before the down migration", table)
		}
	}

	if _, err := tx.ExecContext(ctx, string(down)); err != nil {
		t.Fatalf("execute down migration: %v", err)
	}
	for _, table := range []string{"indexed_blocks", "contract_events", "multisig_transactions", "transaction_confirmations", "indexer_checkpoints"} {
		if tableExists(table) {
			t.Errorf("expected %s to be dropped by the down migration", table)
		}
	}
	var contractsExists bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = $1 AND table_name = 'contracts'
		)
	`, indexerTestSchema).Scan(&contractsExists); err != nil {
		t.Fatalf("inspect contracts table: %v", err)
	}
	if !contractsExists {
		t.Error("down migration must not drop contracts")
	}

	if _, err := tx.ExecContext(ctx, string(up)); err != nil {
		t.Fatalf("execute up migration after down: %v", err)
	}
	for _, table := range []string{"indexed_blocks", "contract_events", "multisig_transactions", "transaction_confirmations", "indexer_checkpoints"} {
		if !tableExists(table) {
			t.Errorf("expected %s to be recreated by the up migration", table)
		}
	}

	if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		t.Fatalf("roll back migration cycle: %v", err)
	}
}

func TestPostgresIndexer_Constraints(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000a1", 100)
	otherContractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000a2", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	t.Run("indexed blocks are unique per contract and block", func(t *testing.T) {
		commit := testRangeCommit(contractID, 100, 100, nil)
		if _, err := repo.CommitRange(ctx, commit); err != nil {
			t.Fatalf("commit range: %v", err)
		}

		_, err := db.ExecContext(ctx, `
			INSERT INTO indexed_blocks (contract_id, block_number, block_hash, parent_hash, created_at)
			VALUES ($1, 100, $2, $3, NOW())
		`, contractID, hashFor(100, 9), hashFor(99, 9))
		requireIndexerPostgresError(t, err, "23505", "uq_indexed_blocks_contract_block_number")
	})

	t.Run("events are unique per contract, block hash and log index", func(t *testing.T) {
		event := testConfirmEventOn(t, contractID, 100, hashFor(100, 1), reIncludedTxHash, 0)
		if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 100, []Event{event})); err != nil {
			t.Fatalf("commit range: %v", err)
		}

		_, err := db.ExecContext(ctx, `
			INSERT INTO contract_events (
				contract_id, event_name, block_number, block_hash, transaction_hash,
				transaction_index, log_index, actor_address, multisig_tx_index, payload, removed
			)
			VALUES ($1, 'ConfirmTransaction', 100, $2, $3, 0, 0, $4, 0, '{}'::jsonb, FALSE)
		`, contractID, hashFor(100, 1), hashFor(100, 7), indexerTestOwner)
		requireIndexerPostgresError(t, err, "23505", "uq_contract_events_occurrence")
	})

	t.Run("a re-included transaction stores a second occurrence", func(t *testing.T) {
		// Same transaction hash and log index in a different block: a fork
		// re-inclusion, which is a distinct occurrence rather than a duplicate.
		event := testConfirmEventOn(t, contractID, 101, hashFor(101, 1), reIncludedTxHash, 0)
		if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 101, 101, []Event{event})); err != nil {
			t.Fatalf("commit re-included range: %v", err)
		}

		var rows int
		if err := db.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM contract_events
			WHERE contract_id = $1 AND transaction_hash = $2 AND log_index = 0
		`, contractID, event.TransactionHash).Scan(&rows); err != nil {
			t.Fatalf("count re-included events: %v", err)
		}
		if rows != 2 {
			t.Errorf("expected both occurrences to be stored, got %d rows", rows)
		}
	})

	t.Run("unsupported event names are rejected", func(t *testing.T) {
		_, err := db.ExecContext(ctx, `
			INSERT INTO contract_events (
				contract_id, event_name, block_number, block_hash, transaction_hash,
				transaction_index, log_index, payload, removed
			)
			VALUES ($1, 'Deposit', 100, $2, $3, 0, 5, '{}'::jsonb, FALSE)
		`, contractID, hashFor(100, 1), hashFor(100, 8))
		requireIndexerPostgresError(t, err, "23514", "chk_contract_events_event_name")
	})

	t.Run("hashes must be canonical lowercase", func(t *testing.T) {
		_, err := db.ExecContext(ctx, `
			INSERT INTO indexed_blocks (contract_id, block_number, block_hash, parent_hash, created_at)
			VALUES ($1, 200, $2, $3, NOW())
		`, contractID, strings.ToUpper(hashFor(200, 1)), hashFor(199, 1))
		requireIndexerPostgresError(t, err, "23514", "chk_indexed_blocks_block_hash")
	})

	t.Run("checkpoint statuses are constrained to the six documented values", func(t *testing.T) {
		setStatus := func(status string, lastError sql.NullString) error {
			_, err := db.ExecContext(ctx, `
				INSERT INTO indexer_checkpoints (contract_id, next_block, status, last_error, updated_at)
				VALUES ($1, 100, $2, $3, NOW())
				ON CONFLICT (contract_id) DO UPDATE SET status = EXCLUDED.status, last_error = EXCLUDED.last_error
			`, otherContractID, status, lastError)
			return err
		}

		for _, status := range []string{"pending", "running", "idle", "disabled", "unsupported"} {
			if err := setStatus(status, sql.NullString{}); err != nil {
				t.Fatalf("expected status %q to be accepted: %v", status, err)
			}
		}
		if err := setStatus("error", sql.NullString{}); err == nil {
			t.Error("expected error status without a message to be rejected")
		} else {
			requireIndexerPostgresError(t, err, "23514", "chk_indexer_checkpoints_last_error")
		}
		if err := setStatus("error", sql.NullString{String: "rpc timeout", Valid: true}); err != nil {
			t.Fatalf("expected error status with a message to be accepted: %v", err)
		}
		if err := setStatus("idle", sql.NullString{String: "stale message", Valid: true}); err == nil {
			t.Error("expected a message outside error status to be rejected")
		} else {
			requireIndexerPostgresError(t, err, "23514", "chk_indexer_checkpoints_last_error")
		}
		if err := setStatus("paused", sql.NullString{}); err == nil {
			t.Error("expected an undocumented status to be rejected")
		} else {
			requireIndexerPostgresError(t, err, "23514", "chk_indexer_checkpoints_status")
		}
	})

	t.Run("uint256 values fit NUMERIC(78,0)", func(t *testing.T) {
		maxUint256 := "115792089237316195423570985008687907853269984665640564039457584007913129639935"
		if _, err := db.ExecContext(ctx, `
			INSERT INTO multisig_transactions (contract_id, multisig_tx_index, value_wei, created_at, updated_at)
			VALUES ($1, $2, $2, NOW(), NOW())
		`, contractID, maxUint256); err != nil {
			t.Fatalf("expected the maximum uint256 to be stored exactly: %v", err)
		}

		var stored string
		if err := db.QueryRowContext(ctx, `
			SELECT value_wei::text FROM multisig_transactions
			WHERE contract_id = $1 AND multisig_tx_index = $2::numeric
		`, contractID, maxUint256).Scan(&stored); err != nil {
			t.Fatalf("read stored value: %v", err)
		}
		if stored != maxUint256 {
			t.Errorf("expected %s to round trip exactly, got %s", maxUint256, stored)
		}

		_, err := db.ExecContext(ctx, `
			INSERT INTO multisig_transactions (contract_id, multisig_tx_index, created_at, updated_at)
			VALUES ($1, $2, NOW(), NOW())
		`, contractID, strings.Repeat("9", 79))
		requireIndexerPostgresError(t, err, "22003", "")
	})

	t.Run("contract deletion is blocked while indexer rows exist", func(t *testing.T) {
		_, err := db.ExecContext(ctx, "DELETE FROM contracts WHERE id = $1", contractID)
		// Several indexer tables reference contracts, so only the error class is pinned.
		requireIndexerPostgresError(t, err, "23503", "")
	})

	t.Run("deleting a projection takes its confirmations with it", func(t *testing.T) {
		var transactionID int64
		if err := db.QueryRowContext(ctx, `
			INSERT INTO multisig_transactions (contract_id, multisig_tx_index, created_at, updated_at)
			VALUES ($1, 42, NOW(), NOW())
			RETURNING id
		`, otherContractID).Scan(&transactionID); err != nil {
			t.Fatalf("seed transaction projection: %v", err)
		}
		if _, err := db.ExecContext(ctx, `
			INSERT INTO transaction_confirmations (multisig_transaction_id, owner_address, confirmed, updated_at)
			VALUES ($1, $2, TRUE, NOW())
		`, transactionID, indexerTestOwner); err != nil {
			t.Fatalf("seed confirmation: %v", err)
		}

		if _, err := db.ExecContext(ctx, "DELETE FROM multisig_transactions WHERE id = $1", transactionID); err != nil {
			t.Fatalf("delete transaction projection: %v", err)
		}
		var remaining int
		if err := db.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM transaction_confirmations WHERE multisig_transaction_id = $1
		`, transactionID).Scan(&remaining); err != nil {
			t.Fatalf("count confirmations: %v", err)
		}
		if remaining != 0 {
			t.Errorf("expected cascading deletion, got %d rows", remaining)
		}
	})
}

func TestPostgresIndexer_WatchSetIsGlobalAndUserIndependent(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)

	tracked := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000b1", 100)
	untracked := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000b2", 200)
	displayDisabled := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000b3", 300)
	globalDisabled := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000b4", 400)
	if _, err := db.ExecContext(t.Context(), "UPDATE contracts SET indexing_enabled = FALSE WHERE id = $1", globalDisabled); err != nil {
		t.Fatalf("disable global indexing: %v", err)
	}

	userA := seedIndexerTestUser(t, db)
	userB := seedIndexerTestUser(t, db)
	trackIndexerTestContract(t, db, userA, tracked, "Treasury", true)
	trackIndexerTestContract(t, db, userB, tracked, "Treasury copy", true)
	trackIndexerTestContract(t, db, userA, displayDisabled, "Hidden", false)

	targets, err := repo.ListWatchTargets(t.Context())
	if err != nil {
		t.Fatalf("list watch targets: %v", err)
	}

	counts := make(map[int64]int)
	for _, target := range targets {
		counts[target.ContractID]++
	}

	if counts[tracked] != 1 {
		t.Errorf("two users tracking one deployment must produce one watch item, got %d", counts[tracked])
	}
	if counts[untracked] != 1 {
		t.Errorf("a deployment with no tracking must still be watched, got %d", counts[untracked])
	}
	if counts[displayDisabled] != 1 {
		t.Errorf("a user display toggle must not remove a deployment, got %d", counts[displayDisabled])
	}
	if counts[globalDisabled] != 1 {
		t.Errorf("a globally disabled deployment stays in the list for the caller to skip, got %d", counts[globalDisabled])
	}

	var globalDisabledFound bool
	for _, target := range targets {
		if target.ContractID == globalDisabled {
			globalDisabledFound = true
			if target.IndexingEnabled {
				t.Error("global flag must be reported as false")
			}
		}
	}
	if !globalDisabledFound {
		t.Error("expected the globally disabled deployment in the watch list")
	}

	if len(targets) != 4 {
		t.Errorf("expected 4 watch targets, got %d", len(targets))
	}
}

func TestPostgresIndexer_EnsureCheckpointUsesStoredStartBlock(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	address := "0x00000000000000000000000000000000000000c1"
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, address, 500)

	checkpoint, err := repo.EnsureCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}
	if checkpoint.NextBlock != 500 {
		t.Errorf("expected next_block 500 from the stored start block, got %d", checkpoint.NextBlock)
	}
	if checkpoint.Status != StatusPending {
		t.Errorf("expected a new checkpoint to be pending, got %q", checkpoint.Status)
	}
	if checkpoint.LastIndexedBlock != nil || checkpoint.LastIndexedBlockHash != nil || checkpoint.LastError != nil {
		t.Errorf("expected empty progress fields, got %+v", checkpoint)
	}

	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 500, 500, nil)); err != nil {
		t.Fatalf("commit first range: %v", err)
	}

	resumed, err := repo.EnsureCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("resume checkpoint: %v", err)
	}
	if resumed.NextBlock != 501 {
		t.Errorf("expected resume at 501, got %d", resumed.NextBlock)
	}

	if _, err := repo.GetCheckpoint(ctx, contractID+1000); !errors.Is(err, ErrCheckpointNotFound) {
		t.Errorf("expected ErrCheckpointNotFound for an unknown contract, got %v", err)
	}
	if _, err := repo.EnsureCheckpoint(ctx, contractID+1000); !errors.Is(err, ErrContractNotFound) {
		t.Errorf("expected ErrContractNotFound for an unknown contract, got %v", err)
	}
	if _, err := repo.EnsureCheckpoint(ctx, 0); err == nil {
		t.Error("expected a non-positive contract id to be rejected")
	}
}

func TestPostgresIndexer_CommitRangeProjectsState(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000d1", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	valueWei := mustUint256(t, "1000000000000000000")
	submit, err := NewSubmitTransactionEvent(contractID, testEventMetadata(100, hashFor(100, 1), 0, 0), indexerTestOwner, 1, "0x000000000000000000000000000000000000dead", valueWei, []byte{0xde, 0xad})
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	confirm := testConfirmEvent(t, contractID, 100, hashFor(100, 1), 2)
	execute := testOwnerEvent(t, contractID, EventExecuteTransaction, 101, hashFor(101, 1), 0, 1)

	checkpoint, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 101, []Event{submit, confirm, execute}))
	if err != nil {
		t.Fatalf("commit range: %v", err)
	}
	if checkpoint.NextBlock != 102 || checkpoint.LastIndexedBlock == nil || *checkpoint.LastIndexedBlock != 101 {
		t.Fatalf("unexpected checkpoint after commit: %+v", checkpoint)
	}
	if checkpoint.LastIndexedBlockHash == nil || *checkpoint.LastIndexedBlockHash != hashFor(101, 1) {
		t.Fatalf("expected the last indexed hash of block 101, got %+v", checkpoint)
	}
	if checkpoint.Status != StatusIdle {
		t.Errorf("expected idle status, got %q", checkpoint.Status)
	}

	var blockCount int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM indexed_blocks WHERE contract_id = $1", contractID).Scan(&blockCount); err != nil {
		t.Fatalf("count indexed blocks: %v", err)
	}
	if blockCount != 2 {
		t.Errorf("expected 2 canonical block rows, got %d", blockCount)
	}

	var (
		toAddress  sql.NullString
		storedWei  sql.NullString
		callData   []byte
		executed   bool
		submitHash sql.NullString
		executeRef sql.NullString
	)
	if err := db.QueryRowContext(ctx, `
		SELECT to_address, value_wei::text, call_data, executed, submit_evm_tx_hash, execute_evm_tx_hash
		FROM multisig_transactions
		WHERE contract_id = $1 AND multisig_tx_index = 1
	`, contractID).Scan(&toAddress, &storedWei, &callData, &executed, &submitHash, &executeRef); err != nil {
		t.Fatalf("read transaction projection: %v", err)
	}
	if !toAddress.Valid || toAddress.String != "0x000000000000000000000000000000000000dead" {
		t.Errorf("unexpected target address: %+v", toAddress)
	}
	if !storedWei.Valid || storedWei.String != "1000000000000000000" {
		t.Errorf("expected the exact wei value, got %+v", storedWei)
	}
	if string(callData) != string([]byte{0xde, 0xad}) {
		t.Errorf("unexpected calldata: %x", callData)
	}
	if !executed {
		t.Error("expected the transaction to be projected as executed")
	}
	if !submitHash.Valid || submitHash.String != submit.TransactionHash {
		t.Errorf("unexpected submit transaction hash: %+v", submitHash)
	}
	if !executeRef.Valid || executeRef.String != execute.TransactionHash {
		t.Errorf("unexpected execute transaction hash: %+v", executeRef)
	}

	var confirmed bool
	var confirmedHash sql.NullString
	if err := db.QueryRowContext(ctx, `
		SELECT confirmed, confirmed_evm_tx_hash
		FROM transaction_confirmations
		WHERE owner_address = $1
		  AND multisig_transaction_id = (
			SELECT id FROM multisig_transactions WHERE contract_id = $2 AND multisig_tx_index = 1
		  )
	`, indexerTestOwner, contractID).Scan(&confirmed, &confirmedHash); err != nil {
		t.Fatalf("read confirmation projection: %v", err)
	}
	if !confirmed || confirmedHash.String != confirm.TransactionHash {
		t.Errorf("unexpected confirmation projection: confirmed=%v hash=%+v", confirmed, confirmedHash)
	}

	// A later revocation clears the current state and records the revoke identity.
	revoke := testOwnerEvent(t, contractID, EventRevokeConfirmation, 102, hashFor(102, 1), 0, 1)
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 102, 102, []Event{revoke})); err != nil {
		t.Fatalf("commit revoke range: %v", err)
	}

	var (
		stillConfirmed bool
		revokedHash    sql.NullString
		keptConfirmRef sql.NullString
	)
	if err := db.QueryRowContext(ctx, `
		SELECT confirmed, revoked_evm_tx_hash, confirmed_evm_tx_hash
		FROM transaction_confirmations
		WHERE owner_address = $1
		  AND multisig_transaction_id = (
			SELECT id FROM multisig_transactions WHERE contract_id = $2 AND multisig_tx_index = 1
		  )
	`, indexerTestOwner, contractID).Scan(&stillConfirmed, &revokedHash, &keptConfirmRef); err != nil {
		t.Fatalf("read revoked confirmation: %v", err)
	}
	if stillConfirmed {
		t.Error("expected the confirmation to be revoked")
	}
	if !revokedHash.Valid || revokedHash.String != revoke.TransactionHash {
		t.Errorf("unexpected revoke hash: %+v", revokedHash)
	}
	if !keptConfirmRef.Valid || keptConfirmRef.String != confirm.TransactionHash {
		t.Errorf("expected the confirm identity to be kept as history, got %+v", keptConfirmRef)
	}
}

func TestPostgresIndexer_CommitRangeIsIdempotent(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000e1", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	valueWei := mustUint256(t, "5000000000000000000")
	submit, err := NewSubmitTransactionEvent(contractID, testEventMetadata(100, hashFor(100, 1), 0, 0), indexerTestOwner, 1, "0x000000000000000000000000000000000000beef", valueWei, nil)
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	confirm := testConfirmEvent(t, contractID, 100, hashFor(100, 1), 2)
	rangeCommit := testRangeCommit(contractID, 100, 101, []Event{submit, confirm})

	first, err := repo.CommitRange(ctx, rangeCommit)
	if err != nil {
		t.Fatalf("first commit: %v", err)
	}
	transactionsBefore := indexerTestTransactionRows(t, db, contractID)
	confirmationsBefore := indexerTestConfirmationRows(t, db, contractID)
	eventsBefore := indexerTestCount(t, db, "contract_events", contractID)
	blocksBefore := indexerTestCount(t, db, "indexed_blocks", contractID)

	second, err := repo.CommitRange(ctx, rangeCommit)
	if err != nil {
		t.Fatalf("repeated commit must be idempotent: %v", err)
	}

	if second.NextBlock != first.NextBlock || !second.UpdatedAt.Equal(first.UpdatedAt) {
		t.Errorf("repeated commit moved the checkpoint: before %+v, after %+v", first, second)
	}
	if got := indexerTestCount(t, db, "contract_events", contractID); got != eventsBefore {
		t.Errorf("repeated commit duplicated events: before %d, after %d", eventsBefore, got)
	}
	if got := indexerTestCount(t, db, "indexed_blocks", contractID); got != blocksBefore {
		t.Errorf("repeated commit duplicated block rows: before %d, after %d", blocksBefore, got)
	}
	if got := indexerTestTransactionRows(t, db, contractID); !slices.Equal(got, transactionsBefore) {
		t.Errorf("repeated commit changed projections:\nbefore %v\nafter  %v", transactionsBefore, got)
	}
	if got := indexerTestConfirmationRows(t, db, contractID); !slices.Equal(got, confirmationsBefore) {
		t.Errorf("repeated commit changed confirmations:\nbefore %v\nafter  %v", confirmationsBefore, got)
	}
}

func TestPostgresIndexer_CommitRangeRejectsGapAndDivergence(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000000f1", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 100, nil)); err != nil {
		t.Fatalf("commit first range: %v", err)
	}

	t.Run("a range above next_block is a gap", func(t *testing.T) {
		_, err := repo.CommitRange(ctx, testRangeCommit(contractID, 105, 105, nil))
		if !errors.Is(err, ErrCheckpointGap) {
			t.Fatalf("expected ErrCheckpointGap, got %v", err)
		}
		if got := indexerTestCount(t, db, "indexed_blocks", contractID); got != 1 {
			t.Errorf("a rejected gap must not write block rows, got %d rows", got)
		}
		checkpoint, err := repo.GetCheckpoint(ctx, contractID)
		if err != nil {
			t.Fatalf("read checkpoint: %v", err)
		}
		if checkpoint.NextBlock != 101 {
			t.Errorf("a rejected gap moved the checkpoint to %d", checkpoint.NextBlock)
		}
	})

	t.Run("a stored hash that differs is a divergence", func(t *testing.T) {
		divergentHash := hashFor(100, 42)
		divergent := testRangeCommit(contractID, 100, 100, []Event{testConfirmEvent(t, contractID, 100, divergentHash, 7)})
		divergent.Blocks[0].BlockHash = divergentHash

		if _, err := repo.CommitRange(ctx, divergent); !errors.Is(err, ErrConflictingBlockHash) {
			t.Fatalf("expected ErrConflictingBlockHash, got %v", err)
		}
		if got := indexerTestCount(t, db, "contract_events", contractID); got != 0 {
			t.Errorf("a rolled back range must not leave events, got %d rows", got)
		}
		if got := indexerTestCount(t, db, "indexed_blocks", contractID); got != 1 {
			t.Errorf("a rolled back range must not leave block rows, got %d rows", got)
		}
	})
}

func TestPostgresIndexer_CommitRangeRollsBackOnFailure(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000101", 200)
	checkpoint, err := repo.EnsureCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	// The payload is a valid JSON object, so the commit passes model validation
	// and the failure happens inside the range transaction, while projecting.
	brokenSubmit := testConfirmEvent(t, contractID, 200, hashFor(200, 1), 0)
	brokenSubmit.EventName = EventSubmitTransaction
	brokenSubmit.MultisigTxIndex = "1"
	brokenSubmit.Payload = []byte(fmt.Sprintf(`{"to":%q,"valueWei":"not-a-decimal","data":"0x"}`, "0x000000000000000000000000000000000000dead"))

	_, err = repo.CommitRange(ctx, testRangeCommit(contractID, 200, 201, []Event{brokenSubmit}))
	if err == nil {
		t.Fatal("expected the injected failure to surface")
	}

	if got := indexerTestCount(t, db, "contract_events", contractID); got != 0 {
		t.Errorf("failed range left %d event rows", got)
	}
	if got := indexerTestCount(t, db, "indexed_blocks", contractID); got != 0 {
		t.Errorf("failed range left %d block rows", got)
	}
	if got := indexerTestCount(t, db, "multisig_transactions", contractID); got != 0 {
		t.Errorf("failed range left %d transaction projections", got)
	}
	after, err := repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint after failure: %v", err)
	}
	if after.NextBlock != checkpoint.NextBlock || !after.UpdatedAt.Equal(checkpoint.UpdatedAt) {
		t.Errorf("failed range moved the checkpoint: before %+v, after %+v", checkpoint, after)
	}
}

func TestPostgresIndexer_RewindToAncestor(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	startBlock := int64(100)
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000111", startBlock)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	valueWei := mustUint256(t, "7")
	submit, err := NewSubmitTransactionEvent(contractID, testEventMetadata(100, hashFor(100, 1), 0, 0), indexerTestOwner, 1, "0x000000000000000000000000000000000000dead", valueWei, nil)
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	confirm := testConfirmEvent(t, contractID, 100, hashFor(100, 1), 1)
	execute := testOwnerEvent(t, contractID, EventExecuteTransaction, 101, hashFor(101, 1), 0, 1)
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 101, []Event{submit, confirm, execute})); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	checkpoint, err := repo.RewindToAncestor(ctx, contractID, 100)
	if err != nil {
		t.Fatalf("rewind to ancestor: %v", err)
	}
	if checkpoint.NextBlock != 101 {
		t.Errorf("expected the rewind to resume at 101, got %d", checkpoint.NextBlock)
	}
	if checkpoint.LastIndexedBlock == nil || *checkpoint.LastIndexedBlock != 100 {
		t.Errorf("expected the last indexed block to fall back to 100, got %+v", checkpoint.LastIndexedBlock)
	}
	if checkpoint.LastIndexedBlockHash == nil || *checkpoint.LastIndexedBlockHash != hashFor(100, 1) {
		t.Errorf("expected the ancestor hash, got %+v", checkpoint.LastIndexedBlockHash)
	}
	if checkpoint.Status != StatusPending {
		t.Errorf("expected pending status after a rewind, got %q", checkpoint.Status)
	}

	var (
		totalEvents     int
		removedEvents   int
		remainingBlocks int
	)
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM contract_events WHERE contract_id = $1", contractID).Scan(&totalEvents); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM contract_events WHERE contract_id = $1 AND removed", contractID).Scan(&removedEvents); err != nil {
		t.Fatalf("count removed events: %v", err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM indexed_blocks WHERE contract_id = $1", contractID).Scan(&remainingBlocks); err != nil {
		t.Fatalf("count blocks: %v", err)
	}
	if totalEvents != 3 || removedEvents != 1 {
		t.Errorf("expected 3 retained events with 1 marked removed, got %d total and %d removed", totalEvents, removedEvents)
	}
	if remainingBlocks != 1 {
		t.Errorf("expected only the ancestor block row to remain, got %d", remainingBlocks)
	}

	// The execution event is orphaned, so the projection must drop back to
	// unexecuted while the block 100 confirmation survives.
	executed := indexerTestSingleBool(t, db, `
		SELECT executed FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = 1
	`, contractID)
	if executed {
		t.Error("expected the orphaned execution to be removed from the projection")
	}
	confirmed := indexerTestSingleBool(t, db, `
		SELECT confirmed FROM transaction_confirmations
		WHERE multisig_transaction_id = (
			SELECT id FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = 1
		)
	`, contractID)
	if !confirmed {
		t.Error("expected the retained confirmation to stay projected")
	}

	// Rescanning the fork point works, and the removed occurrence stays as history.
	// Block 101 now has a different canonical hash, so the new event row is a
	// second occurrence rather than a duplicate of the orphaned one.
	forkHash := hashFor(101, 42)
	replay := testOwnerEvent(t, contractID, EventExecuteTransaction, 101, forkHash, 0, 1)
	forkCommit := testRangeCommit(contractID, 101, 101, []Event{replay})
	forkCommit.Blocks[0].BlockHash = forkHash
	if _, err := repo.CommitRange(ctx, forkCommit); err != nil {
		t.Fatalf("rescan after rewind: %v", err)
	}
	if got := indexerTestCount(t, db, "contract_events", contractID); got != 4 {
		t.Errorf("expected the removed row to be kept alongside the new occurrence, got %d rows", got)
	}
	if got := indexerTestCount(t, db, "indexed_blocks", contractID); got != 2 {
		t.Errorf("expected the rescanned block row, got %d rows", got)
	}
}

func TestPostgresIndexer_RewindToStart(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	startBlock := int64(300)
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000121", startBlock)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	valueWei := mustUint256(t, "1")
	submit, err := NewSubmitTransactionEvent(contractID, testEventMetadata(300, hashFor(300, 1), 0, 0), indexerTestOwner, 2, "0x000000000000000000000000000000000000dead", valueWei, nil)
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	confirm := testConfirmEvent(t, contractID, 301, hashFor(301, 1), 0)
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 300, 301, []Event{submit, confirm})); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	checkpoint, err := repo.RewindToStart(ctx, contractID)
	if err != nil {
		t.Fatalf("rewind to start: %v", err)
	}
	if checkpoint.NextBlock != startBlock {
		t.Errorf("expected a resume at the stored start block %d, got %d", startBlock, checkpoint.NextBlock)
	}
	if checkpoint.LastIndexedBlock != nil || checkpoint.LastIndexedBlockHash != nil {
		t.Errorf("expected the last indexed block to be cleared, got %+v", checkpoint)
	}
	if checkpoint.Status != StatusPending {
		t.Errorf("expected pending status, got %q", checkpoint.Status)
	}

	if got := indexerTestCount(t, db, "indexed_blocks", contractID); got != 0 {
		t.Errorf("expected no canonical block rows, got %d", got)
	}
	if got := indexerTestCount(t, db, "contract_events", contractID); got != 2 {
		t.Errorf("expected both event rows to be retained, got %d", got)
	}
	removedEvents := indexerTestCountWhere(t, db, "contract_events", contractID, "removed")
	if removedEvents != 2 {
		t.Errorf("expected every event to be marked removed, got %d", removedEvents)
	}
	if got := indexerTestCount(t, db, "multisig_transactions", contractID); got != 0 {
		t.Errorf("expected projections to be cleared, got %d rows", got)
	}
	var confirmations int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM transaction_confirmations").Scan(&confirmations); err != nil {
		t.Fatalf("count confirmations: %v", err)
	}
	if confirmations != 0 {
		t.Errorf("expected confirmations to be cleared, got %d rows", confirmations)
	}
}

func TestPostgresIndexer_RescanAfterRewindToAncestorRestoresCanonicalEvents(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000161", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	valueWei := mustUint256(t, "42")
	submit, err := NewSubmitTransactionEvent(contractID, testEventMetadata(100, hashFor(100, 1), 0, 0), indexerTestOwner, 1, "0x000000000000000000000000000000000000dead", valueWei, nil)
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	confirm := testConfirmEvent(t, contractID, 100, hashFor(100, 1), 1)
	execute := testOwnerEvent(t, contractID, EventExecuteTransaction, 101, hashFor(101, 1), 0, 1)
	original := testRangeCommit(contractID, 100, 101, []Event{submit, confirm, execute})
	if _, err := repo.CommitRange(ctx, original); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	eventsBefore := indexerTestCount(t, db, "contract_events", contractID)
	stateBefore := indexerTestTransactionState(t, db, contractID)
	if !indexerTestSingleBool(t, db, `
		SELECT executed FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = 1
	`, contractID) {
		t.Fatal("expected the transaction to be projected as executed before the rewind")
	}

	if _, err := repo.RewindToAncestor(ctx, contractID, 100); err != nil {
		t.Fatalf("rewind to ancestor: %v", err)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed"); got != 1 {
		t.Fatalf("expected the block 101 event to be removed after the rewind, got %d", got)
	}

	// The fork that was rewound comes back, which is what a false-positive rewind
	// or a flapping RPC node looks like. The same block hash and log index are
	// committed again and the occurrence must return to canonical.
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 101, 101, []Event{execute})); err != nil {
		t.Fatalf("rescan the restored fork: %v", err)
	}

	if got := indexerTestCount(t, db, "contract_events", contractID); got != eventsBefore {
		t.Errorf("the rescan must reuse the existing occurrence, event rows went from %d to %d", eventsBefore, got)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed"); got != 0 {
		t.Errorf("expected every rescanned event to be canonical, got %d removed", got)
	}
	if got := indexerTestCount(t, db, "indexed_blocks", contractID); got != 2 {
		t.Errorf("expected both canonical block rows, got %d", got)
	}
	if got := indexerTestTransactionState(t, db, contractID); !slices.Equal(got, stateBefore) {
		t.Errorf("the rescan did not restore the projection state:\nbefore %v\nafter  %v", stateBefore, got)
	}
	if !indexerTestSingleBool(t, db, `
		SELECT executed FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = 1
	`, contractID) {
		t.Error("expected the restored execution to be projected")
	}

	// A rebuild must derive the same state from the events that are canonical now.
	if err := repo.RebuildProjections(ctx, contractID); err != nil {
		t.Fatalf("rebuild after the rescan: %v", err)
	}
	if got := indexerTestTransactionState(t, db, contractID); !slices.Equal(got, stateBefore) {
		t.Errorf("the rebuild did not reproduce the restored state:\nbefore %v\nafter  %v", stateBefore, got)
	}
}

func TestPostgresIndexer_RescanAfterRewindToStartRestoresCanonicalEvents(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	startBlock := int64(300)
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000171", startBlock)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	valueWei := mustUint256(t, "9")
	submit, err := NewSubmitTransactionEvent(contractID, testEventMetadata(300, hashFor(300, 1), 0, 0), indexerTestOwner, 1, "0x000000000000000000000000000000000000dead", valueWei, []byte{0x01})
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	confirm := testConfirmEvent(t, contractID, 300, hashFor(300, 1), 1)
	execute := testOwnerEvent(t, contractID, EventExecuteTransaction, 301, hashFor(301, 1), 0, 1)
	original := testRangeCommit(contractID, startBlock, 301, []Event{submit, confirm, execute})
	if _, err := repo.CommitRange(ctx, original); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	eventsBefore := indexerTestCount(t, db, "contract_events", contractID)
	stateBefore := indexerTestTransactionState(t, db, contractID)

	if _, err := repo.RewindToStart(ctx, contractID); err != nil {
		t.Fatalf("rewind to start: %v", err)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed"); got != eventsBefore {
		t.Fatalf("expected every event to be removed after the rewind, got %d of %d", got, eventsBefore)
	}

	// Rescan the original range with the original hashes and log indexes.
	if _, err := repo.CommitRange(ctx, original); err != nil {
		t.Fatalf("rescan the original range: %v", err)
	}

	if got := indexerTestCount(t, db, "contract_events", contractID); got != eventsBefore {
		t.Errorf("the rescan must reuse the existing occurrences, event rows went from %d to %d", eventsBefore, got)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed"); got != 0 {
		t.Errorf("expected every rescanned event to be canonical, got %d removed", got)
	}
	if got := indexerTestCount(t, db, "indexed_blocks", contractID); got != 2 {
		t.Errorf("expected both canonical block rows to be restored, got %d", got)
	}
	checkpoint, err := repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint after the rescan: %v", err)
	}
	if checkpoint.NextBlock != 302 {
		t.Errorf("expected the rescan to advance to 302, got %d", checkpoint.NextBlock)
	}
	if got := indexerTestTransactionState(t, db, contractID); !slices.Equal(got, stateBefore) {
		t.Errorf("the rescan did not restore the projection state:\nbefore %v\nafter  %v", stateBefore, got)
	}

	if err := repo.RebuildProjections(ctx, contractID); err != nil {
		t.Fatalf("rebuild after the rescan: %v", err)
	}
	if got := indexerTestTransactionState(t, db, contractID); !slices.Equal(got, stateBefore) {
		t.Errorf("the rebuild did not reproduce the restored state:\nbefore %v\nafter  %v", stateBefore, got)
	}
}

func TestPostgresIndexer_RebuildProjectionsIsDeterministic(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000131", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	valueWei := mustUint256(t, "12345678901234567890")
	submit, err := NewSubmitTransactionEvent(contractID, testEventMetadata(100, hashFor(100, 1), 0, 0), indexerTestOwner, 4, "0x000000000000000000000000000000000000dead", valueWei, []byte{0x01})
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	confirm := testConfirmEvent(t, contractID, 100, hashFor(100, 1), 1)
	revoke := testOwnerEvent(t, contractID, EventRevokeConfirmation, 100, hashFor(100, 1), 2, 4)
	secondConfirm := testConfirmEvent(t, contractID, 101, hashFor(101, 1), 0)

	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 101, []Event{submit, confirm, revoke, secondConfirm})); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	// A rebuild recreates rows, so timestamps are expected to move. The
	// projected state is what must be identical.
	transactionsBefore := indexerTestTransactionState(t, db, contractID)
	confirmationsBefore := indexerTestConfirmationState(t, db, contractID)

	if err := repo.RebuildProjections(ctx, contractID); err != nil {
		t.Fatalf("rebuild projections: %v", err)
	}

	if got := indexerTestTransactionState(t, db, contractID); !slices.Equal(got, transactionsBefore) {
		t.Errorf("rebuild changed transactions:\nbefore %v\nafter  %v", transactionsBefore, got)
	}
	if got := indexerTestConfirmationState(t, db, contractID); !slices.Equal(got, confirmationsBefore) {
		t.Errorf("rebuild changed confirmations:\nbefore %v\nafter  %v", confirmationsBefore, got)
	}

	// A rebuild after a rewind must reproduce the rewind's own projection state.
	if _, err := repo.RewindToAncestor(ctx, contractID, 100); err != nil {
		t.Fatalf("rewind: %v", err)
	}
	afterRewind := indexerTestTransactionState(t, db, contractID)
	if err := repo.RebuildProjections(ctx, contractID); err != nil {
		t.Fatalf("rebuild after rewind: %v", err)
	}
	if got := indexerTestTransactionState(t, db, contractID); !slices.Equal(got, afterRewind) {
		t.Errorf("rebuild after rewind is not repeatable:\nbefore %v\nafter  %v", afterRewind, got)
	}
}

func TestPostgresIndexer_CheckpointStatusHelpers(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000141", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	if _, err := repo.SetCheckpointStatus(ctx, contractID, StatusRunning, ""); err != nil {
		t.Fatalf("set running: %v", err)
	}
	if _, err := repo.SetCheckpointStatus(ctx, contractID, StatusError, "rpc unavailable"); err != nil {
		t.Fatalf("set error: %v", err)
	}
	afterError, err := repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint: %v", err)
	}
	if afterError.Status != StatusError || afterError.LastError == nil || *afterError.LastError != "rpc unavailable" {
		t.Errorf("unexpected error checkpoint: %+v", afterError)
	}

	cleared, err := repo.SetCheckpointStatus(ctx, contractID, StatusIdle, "")
	if err != nil {
		t.Fatalf("clear error: %v", err)
	}
	if cleared.Status != StatusIdle || cleared.LastError != nil {
		t.Errorf("expected a successful status to clear last_error, got %+v", cleared)
	}

	if _, err := repo.SetCheckpointStatus(ctx, contractID, StatusError, ""); err == nil {
		t.Error("expected error status without a message to be rejected")
	}
	if _, err := repo.SetCheckpointStatus(ctx, contractID, StatusIdle, "leftover message"); err == nil {
		t.Error("expected a message outside error status to be rejected")
	}
	if _, err := repo.SetCheckpointStatus(ctx, contractID, "paused", ""); err == nil {
		t.Error("expected an unsupported status to be rejected")
	}
	if _, err := repo.SetCheckpointStatus(ctx, contractID+1000, StatusIdle, ""); !errors.Is(err, ErrCheckpointNotFound) {
		t.Errorf("expected ErrCheckpointNotFound, got %v", err)
	}

	disabledID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000142", 100)
	if _, err := repo.EnsureCheckpoint(ctx, disabledID); err != nil {
		t.Fatalf("ensure disabled checkpoint: %v", err)
	}
	if _, err := repo.SetCheckpointStatus(ctx, disabledID, StatusDisabled, ""); err != nil {
		t.Fatalf("set disabled: %v", err)
	}
	if _, err := repo.CommitRange(ctx, testRangeCommit(disabledID, 100, 100, nil)); !errors.Is(err, ErrCheckpointNotIndexable) {
		t.Errorf("expected ErrCheckpointNotIndexable for a disabled checkpoint, got %v", err)
	}

	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 500, 500, nil)); !errors.Is(err, ErrCheckpointGap) {
		t.Fatalf("expected ErrCheckpointGap before the reset check, got %v", err)
	}
	resetCount, err := repo.ResetRunningCheckpoints(ctx)
	if err != nil {
		t.Fatalf("reset running checkpoints: %v", err)
	}
	if resetCount != 0 {
		t.Errorf("expected no running checkpoint to reset, got %d", resetCount)
	}
	if _, err := repo.SetCheckpointStatus(ctx, contractID, StatusRunning, ""); err != nil {
		t.Fatalf("set running again: %v", err)
	}
	resetCount, err = repo.ResetRunningCheckpoints(ctx)
	if err != nil {
		t.Fatalf("reset running checkpoints: %v", err)
	}
	if resetCount != 1 {
		t.Errorf("expected one stale running checkpoint to be reset, got %d", resetCount)
	}
	reset, err := repo.GetCheckpoint(ctx, contractID)
	if err != nil {
		t.Fatalf("read checkpoint: %v", err)
	}
	if reset.Status != StatusPending || reset.LastError != nil {
		t.Errorf("expected a stale running checkpoint to become pending, got %+v", reset)
	}
}

func TestPostgresIndexer_RewindValidation(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()
	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000151", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}
	if _, err := repo.CommitRange(ctx, testRangeCommit(contractID, 100, 101, nil)); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	if _, err := repo.RewindToAncestor(ctx, contractID, -1); err == nil {
		t.Error("expected a negative ancestor to be rejected")
	}
	if _, err := repo.RewindToAncestor(ctx, contractID, 99); !errors.Is(err, ErrAncestorNotFound) {
		t.Errorf("expected ErrAncestorNotFound for an unindexed block, got %v", err)
	}
	if _, err := repo.RewindToAncestor(ctx, contractID, 102); err == nil {
		t.Error("expected an ancestor at or above next_block to be rejected")
	}
	if _, err := repo.RewindToAncestor(ctx, contractID+1000, 100); !errors.Is(err, ErrCheckpointNotFound) {
		t.Errorf("expected ErrCheckpointNotFound for an unknown contract, got %v", err)
	}
	if err := repo.RebuildProjections(ctx, contractID+1000); !errors.Is(err, ErrCheckpointNotFound) {
		t.Errorf("expected ErrCheckpointNotFound from rebuild, got %v", err)
	}
}

func setupPostgresIndexerTest(t *testing.T) (*sql.DB, *PostgresRepository) {
	t.Helper()
	ctx := t.Context()

	baseDSN := os.Getenv("DATABASE_URL")
	if baseDSN == "" {
		t.Skip("skipping integration test: DATABASE_URL not set")
	}

	admin, err := sql.Open("pgx", baseDSN)
	if err != nil {
		t.Fatalf("open admin connection: %v", err)
	}
	if err := admin.PingContext(ctx); err != nil {
		admin.Close()
		t.Fatalf("connect to the database: %v", err)
	}
	if err := prepareIndexerTestSchema(ctx, admin); err != nil {
		admin.Close()
		t.Fatalf("prepare the indexer test schema: %v", err)
	}
	if err := admin.Close(); err != nil {
		t.Fatalf("close admin connection: %v", err)
	}

	db, err := sql.Open("pgx", indexerTestDSN(baseDSN))
	if err != nil {
		t.Fatalf("open test connection: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("connect to the indexer test schema: %v", err)
	}

	// Truncate only the dedicated schema. internal/contract tests truncate the
	// shared public contract tables, so this suite must not depend on public.
	const truncate = `
		TRUNCATE transaction_confirmations, multisig_transactions, contract_events,
		         indexed_blocks, indexer_checkpoints, user_contracts, wallets,
		         user_sessions, users, contracts
	`
	if _, err := db.ExecContext(ctx, truncate); err != nil {
		t.Fatalf("truncate indexer test tables: %v", err)
	}

	return db, NewPostgresRepository(db)
}

// prepareIndexerTestSchema builds a schema that contains the full migration set
// once per test run, so this suite is independent of the shared public schema.
func prepareIndexerTestSchema(ctx context.Context, admin *sql.DB) error {
	indexerTestSchemaOnce.Do(func() {
		indexerTestSchemaErr = createIndexerTestSchema(ctx, admin)
	})
	return indexerTestSchemaErr
}

func createIndexerTestSchema(ctx context.Context, admin *sql.DB) error {
	conn, err := admin.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "DROP SCHEMA IF EXISTS "+indexerTestSchema+" CASCADE"); err != nil {
		return fmt.Errorf("drop stale schema: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "CREATE SCHEMA "+indexerTestSchema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "SET search_path TO "+indexerTestSchema); err != nil {
		return fmt.Errorf("set search path: %w", err)
	}

	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	var upFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".up.sql") {
			upFiles = append(upFiles, entry.Name())
		}
	}
	sort.Strings(upFiles)

	for _, filename := range upFiles {
		content, err := migrations.FS.ReadFile(filename)
		if err != nil {
			return fmt.Errorf("read %s: %w", filename, err)
		}
		if _, err := conn.ExecContext(ctx, string(content)); err != nil {
			return fmt.Errorf("apply %s: %w", filename, err)
		}
	}
	return nil
}

// indexerTestDSN points the pooled connections of the test at the dedicated
// schema. pgx accepts search_path as a startup parameter.
func indexerTestDSN(baseDSN string) string {
	if strings.Contains(baseDSN, "://") {
		separator := "?"
		if strings.Contains(baseDSN, "?") {
			separator = "&"
		}
		return baseDSN + separator + "search_path=" + indexerTestSchema
	}
	return baseDSN + " search_path=" + indexerTestSchema
}

func seedIndexerTestDeployment(t *testing.T, db *sql.DB, chainID int64, address string, startBlock int64) int64 {
	t.Helper()

	var contractID int64
	if err := db.QueryRowContext(t.Context(), `
		INSERT INTO contracts (chain_id, address, start_block, indexing_enabled, created_at, updated_at)
		VALUES ($1, $2, $3, TRUE, NOW(), NOW())
		RETURNING id
	`, chainID, address, startBlock).Scan(&contractID); err != nil {
		t.Fatalf("seed deployment %s: %v", address, err)
	}
	return contractID
}

func seedIndexerTestUser(t *testing.T, db *sql.DB) int64 {
	t.Helper()

	var userID int64
	email := fmt.Sprintf("indexer-pg-%d@example.com", time.Now().UnixNano())
	if err := db.QueryRowContext(t.Context(), `
		INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id
	`, email, "not-used-by-indexer-tests").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return userID
}

func trackIndexerTestContract(t *testing.T, db *sql.DB, userID, contractID int64, label string, enabled bool) {
	t.Helper()

	if _, err := db.ExecContext(t.Context(), `
		INSERT INTO user_contracts (user_id, contract_id, label, enabled, created_at, updated_at)
		VALUES ($1, $2, $3, $4, NOW(), NOW())
	`, userID, contractID, label, enabled); err != nil {
		t.Fatalf("track contract %d: %v", contractID, err)
	}
}

func testEventMetadata(blockNumber int64, blockHash string, transactionIndex, logIndex int) EventMetadata {
	return EventMetadata{
		BlockNumber:      blockNumber,
		BlockHash:        blockHash,
		TransactionHash:  hashFor(blockNumber, 77+transactionIndex),
		TransactionIndex: transactionIndex,
		LogIndex:         logIndex,
	}
}

func testConfirmEvent(t *testing.T, contractID, blockNumber int64, blockHash string, logIndex int) Event {
	t.Helper()

	return testConfirmEventOn(t, contractID, blockNumber, blockHash, hashFor(blockNumber, 80+logIndex), logIndex)
}

func testConfirmEventOn(t *testing.T, contractID, blockNumber int64, blockHash string, transactionHash string, logIndex int) Event {
	t.Helper()

	event, err := NewOwnerEvent(contractID, EventMetadata{
		BlockNumber:      blockNumber,
		BlockHash:        blockHash,
		TransactionHash:  transactionHash,
		TransactionIndex: 0,
		LogIndex:         logIndex,
	}, EventConfirmTransaction, indexerTestOwner, 1)
	if err != nil {
		t.Fatalf("build confirm event: %v", err)
	}
	return event
}

func testOwnerEvent(t *testing.T, contractID int64, eventName string, blockNumber int64, blockHash string, logIndex int, multisigTxIndex uint64) Event {
	t.Helper()

	event, err := NewOwnerEvent(contractID, EventMetadata{
		BlockNumber:      blockNumber,
		BlockHash:        blockHash,
		TransactionHash:  hashFor(blockNumber, 90+logIndex),
		TransactionIndex: 0,
		LogIndex:         logIndex,
	}, eventName, indexerTestOwner, multisigTxIndex)
	if err != nil {
		t.Fatalf("build %s event: %v", eventName, err)
	}
	return event
}

// testRangeCommit builds a complete commit for a range, including one block
// header per block.
func testRangeCommit(contractID, fromBlock, toBlock int64, events []Event) RangeCommit {
	blocks := make([]BlockHeader, 0, toBlock-fromBlock+1)
	for number := fromBlock; number <= toBlock; number++ {
		blocks = append(blocks, BlockHeader{
			BlockNumber: number,
			BlockHash:   hashFor(number, 1),
			ParentHash:  hashFor(number-1, 1),
		})
	}
	return RangeCommit{
		ContractID: contractID,
		FromBlock:  fromBlock,
		ToBlock:    toBlock,
		Blocks:     blocks,
		Events:     events,
		Status:     StatusIdle,
	}
}

func mustUint256(t *testing.T, value string) *big.Int {
	t.Helper()

	parsed, err := ParseUint256Decimal(value)
	if err != nil {
		t.Fatalf("parse uint256 %q: %v", value, err)
	}
	return parsed
}

func indexerTestCount(t *testing.T, db *sql.DB, table string, contractID int64) int {
	t.Helper()

	var count int
	query := fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE contract_id = $1", table)
	if err := db.QueryRowContext(t.Context(), query, contractID).Scan(&count); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return count
}

func indexerTestCountWhere(t *testing.T, db *sql.DB, table string, contractID int64, condition string) int {
	t.Helper()

	var count int
	query := fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE contract_id = $1 AND %s", table, condition)
	if err := db.QueryRowContext(t.Context(), query, contractID).Scan(&count); err != nil {
		t.Fatalf("count %s where %s: %v", table, condition, err)
	}
	return count
}

func indexerTestTransactionRows(t *testing.T, db *sql.DB, contractID int64) []string {
	t.Helper()

	rows, err := db.QueryContext(t.Context(), `
		SELECT multisig_tx_index::text, COALESCE(to_address, ''), COALESCE(value_wei::text, ''),
		       COALESCE(encode(call_data, 'hex'), ''), executed, COALESCE(submitted_by, ''),
		       COALESCE(submit_evm_tx_hash, ''), COALESCE(submit_block_number::text, ''),
		       COALESCE(execute_evm_tx_hash, ''), COALESCE(execute_block_number::text, ''),
		       created_at::text, updated_at::text
		FROM multisig_transactions
		WHERE contract_id = $1
		ORDER BY multisig_tx_index
	`, contractID)
	if err != nil {
		t.Fatalf("read transaction projections: %v", err)
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var values [12]string
		var executed bool
		if err := rows.Scan(
			&values[0], &values[1], &values[2], &values[3], &executed, &values[5],
			&values[6], &values[7], &values[8], &values[9], &values[10], &values[11],
		); err != nil {
			t.Fatalf("scan transaction projection: %v", err)
		}
		if executed {
			values[4] = "executed"
		} else {
			values[4] = "pending"
		}
		result = append(result, strings.Join(values[:], "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read transaction projections: %v", err)
	}
	return result
}

// indexerTestTransactionState is the projection state without row timestamps.
func indexerTestTransactionState(t *testing.T, db *sql.DB, contractID int64) []string {
	t.Helper()

	return indexerTestRows(t, db, `
		SELECT multisig_tx_index::text, COALESCE(to_address, ''), COALESCE(value_wei::text, ''),
		       COALESCE(encode(call_data, 'hex'), ''), executed::text, COALESCE(submitted_by, ''),
		       COALESCE(submit_evm_tx_hash, ''), COALESCE(submit_block_number::text, ''),
		       COALESCE(execute_evm_tx_hash, ''), COALESCE(execute_block_number::text, '')
		FROM multisig_transactions
		WHERE contract_id = $1
		ORDER BY multisig_tx_index
	`, contractID, 10)
}

// indexerTestConfirmationState is the confirmation state without row timestamps.
func indexerTestConfirmationState(t *testing.T, db *sql.DB, contractID int64) []string {
	t.Helper()

	return indexerTestRows(t, db, `
		SELECT c.owner_address, c.confirmed::text, COALESCE(c.confirmed_evm_tx_hash, ''),
		       COALESCE(c.confirmed_block_number::text, ''), COALESCE(c.revoked_evm_tx_hash, ''),
		       COALESCE(c.revoked_block_number::text, '')
		FROM transaction_confirmations c
		JOIN multisig_transactions t ON t.id = c.multisig_transaction_id
		WHERE t.contract_id = $1
		ORDER BY t.multisig_tx_index, c.owner_address
	`, contractID, 6)
}

func indexerTestRows(t *testing.T, db *sql.DB, query string, contractID int64, columns int) []string {
	t.Helper()

	rows, err := db.QueryContext(t.Context(), query, contractID)
	if err != nil {
		t.Fatalf("read projection rows: %v", err)
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		values := make([]string, columns)
		destinations := make([]any, columns)
		for i := range values {
			destinations[i] = &values[i]
		}
		if err := rows.Scan(destinations...); err != nil {
			t.Fatalf("scan projection row: %v", err)
		}
		result = append(result, strings.Join(values, "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read projection rows: %v", err)
	}
	return result
}

func indexerTestConfirmationRows(t *testing.T, db *sql.DB, contractID int64) []string {
	t.Helper()

	rows, err := db.QueryContext(t.Context(), `
		SELECT c.owner_address, c.confirmed, COALESCE(c.confirmed_evm_tx_hash, ''),
		       COALESCE(c.confirmed_block_number::text, ''), COALESCE(c.revoked_evm_tx_hash, ''),
		       COALESCE(c.revoked_block_number::text, ''), c.updated_at::text
		FROM transaction_confirmations c
		JOIN multisig_transactions t ON t.id = c.multisig_transaction_id
		WHERE t.contract_id = $1
		ORDER BY t.multisig_tx_index, c.owner_address
	`, contractID)
	if err != nil {
		t.Fatalf("read confirmation projections: %v", err)
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var values [7]string
		var confirmed bool
		if err := rows.Scan(&values[0], &confirmed, &values[2], &values[3], &values[4], &values[5], &values[6]); err != nil {
			t.Fatalf("scan confirmation projection: %v", err)
		}
		if confirmed {
			values[1] = "confirmed"
		} else {
			values[1] = "revoked"
		}
		result = append(result, strings.Join(values[:], "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read confirmation projections: %v", err)
	}
	return result
}

func indexerTestSingleBool(t *testing.T, db *sql.DB, query string, args ...any) bool {
	t.Helper()

	var value bool
	if err := db.QueryRowContext(t.Context(), query, args...).Scan(&value); err != nil {
		t.Fatalf("read boolean: %v", err)
	}
	return value
}

func requireIndexerPostgresError(t *testing.T, err error, code string, constraint string) *pgconn.PgError {
	t.Helper()

	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("expected PostgreSQL error %s, got: %v", code, err)
	}
	if pgErr.Code != code {
		t.Fatalf("expected PostgreSQL error %s, got %s: %v", code, pgErr.Code, pgErr)
	}
	if constraint != "" && pgErr.ConstraintName != constraint {
		t.Errorf("expected constraint %s, got %q", constraint, pgErr.ConstraintName)
	}
	return pgErr
}
