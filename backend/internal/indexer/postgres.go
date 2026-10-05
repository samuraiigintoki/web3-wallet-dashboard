package indexer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

var _ Repository = (*PostgresRepository)(nil)

// PostgresRepository owns every SQL statement of the indexer persistence layer.
type PostgresRepository struct {
	db *sql.DB
}

func NewPostgresRepository(db *sql.DB) *PostgresRepository {
	return &PostgresRepository{db: db}
}

const checkpointColumns = `contract_id, next_block, last_indexed_block, last_indexed_block_hash, status, last_error, updated_at`

// ListWatchTargets returns the global contract table ordered by id. It does not
// join user_contracts: tracking relationships change what a user sees, never
// what is indexed.
func (r *PostgresRepository) ListWatchTargets(ctx context.Context) ([]WatchTarget, error) {
	const query = `
		SELECT id, chain_id, address, start_block, indexing_enabled
		FROM contracts
		ORDER BY id
	`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("list watch targets: %w", err)
	}
	defer rows.Close()

	var targets []WatchTarget
	for rows.Next() {
		var target WatchTarget
		if err := rows.Scan(&target.ContractID, &target.ChainID, &target.Address, &target.StartBlock, &target.IndexingEnabled); err != nil {
			return nil, fmt.Errorf("scan watch target: %w", err)
		}
		targets = append(targets, target)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list watch targets: %w", err)
	}
	return targets, nil
}

// EnsureCheckpoint initializes a missing checkpoint from the stored start block
// and leaves an existing row untouched.
func (r *PostgresRepository) EnsureCheckpoint(ctx context.Context, contractID int64) (*Checkpoint, error) {
	if contractID <= 0 {
		return nil, ValidationError{Field: "contractId", Message: "must be positive"}
	}

	const insert = `
		INSERT INTO indexer_checkpoints (contract_id, next_block, status, updated_at)
		SELECT c.id, c.start_block, 'pending', NOW()
		FROM contracts c
		WHERE c.id = $1
		ON CONFLICT (contract_id) DO NOTHING
	`
	if _, err := r.db.ExecContext(ctx, insert, contractID); err != nil {
		return nil, fmt.Errorf("ensure checkpoint: %w", err)
	}

	checkpoint, err := r.GetCheckpoint(ctx, contractID)
	if errors.Is(err, ErrCheckpointNotFound) {
		return nil, ErrContractNotFound
	}
	return checkpoint, err
}

func (r *PostgresRepository) GetCheckpoint(ctx context.Context, contractID int64) (*Checkpoint, error) {
	if contractID <= 0 {
		return nil, ValidationError{Field: "contractId", Message: "must be positive"}
	}

	checkpoint, err := scanCheckpoint(r.db.QueryRowContext(ctx, selectCheckpointQuery, contractID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrCheckpointNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get checkpoint: %w", err)
	}
	return checkpoint, nil
}

const selectCheckpointQuery = `SELECT ` + checkpointColumns + ` FROM indexer_checkpoints WHERE contract_id = $1`

func (r *PostgresRepository) SetCheckpointStatus(ctx context.Context, contractID int64, status CheckpointStatus, lastError string) (*Checkpoint, error) {
	if contractID <= 0 {
		return nil, ValidationError{Field: "contractId", Message: "must be positive"}
	}
	if !status.Valid() {
		return nil, ValidationError{Field: "status", Message: fmt.Sprintf("unsupported checkpoint status %q", status)}
	}
	lastError = strings.TrimSpace(lastError)
	if status == StatusError && lastError == "" {
		return nil, ValidationError{Field: "lastError", Message: "is required for error status"}
	}
	if status != StatusError && lastError != "" {
		return nil, ValidationError{Field: "lastError", Message: "is stored only for error status"}
	}

	const query = `
		UPDATE indexer_checkpoints
		SET status = $2, last_error = NULLIF($3::text, ''), updated_at = NOW()
		WHERE contract_id = $1
		RETURNING ` + checkpointColumns

	checkpoint, err := scanCheckpoint(r.db.QueryRowContext(ctx, query, contractID, string(status), lastError))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrCheckpointNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("set checkpoint status: %w", err)
	}
	return checkpoint, nil
}

// ResetRunningCheckpoints clears state left by a process that stopped mid range.
func (r *PostgresRepository) ResetRunningCheckpoints(ctx context.Context) (int64, error) {
	const query = `
		UPDATE indexer_checkpoints
		SET status = 'pending', last_error = NULL, updated_at = NOW()
		WHERE status = 'running'
	`

	result, err := r.db.ExecContext(ctx, query)
	if err != nil {
		return 0, fmt.Errorf("reset running checkpoints: %w", err)
	}
	reset, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("reset running checkpoints: %w", err)
	}
	return reset, nil
}

// CommitRange applies one inclusive range in a single transaction. Repeating a
// commit is idempotent because block rows and event rows use conflict-safe
// inserts and projections are declarative upserts.
func (r *PostgresRepository) CommitRange(ctx context.Context, commit RangeCommit) (*Checkpoint, error) {
	if err := commit.Validate(); err != nil {
		return nil, err
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin range commit: %w", err)
	}
	defer tx.Rollback()

	current, err := lockCheckpoint(ctx, tx, commit.ContractID)
	if err != nil {
		return nil, err
	}

	// A commit above next_block would skip an unindexed range. A commit at
	// next_block advances the checkpoint. A commit below it is a replay of an
	// already committed range: its rows are applied idempotently and the
	// checkpoint keeps its position.
	switch {
	case commit.FromBlock > current.NextBlock:
		return nil, fmt.Errorf("%w: commit starts at %d, checkpoint next block is %d", ErrCheckpointGap, commit.FromBlock, current.NextBlock)
	case current.Status == StatusDisabled || current.Status == StatusUnsupported:
		return nil, fmt.Errorf("%w: checkpoint status is %q", ErrCheckpointNotIndexable, current.Status)
	}
	advancing := commit.FromBlock == current.NextBlock

	if err := insertBlockHeaders(ctx, tx, commit); err != nil {
		return nil, err
	}
	if err := insertEvents(ctx, tx, commit); err != nil {
		return nil, err
	}
	if err := applyProjections(ctx, tx, commit.ContractID, commit.Events); err != nil {
		return nil, err
	}

	updated := current
	if advancing {
		updated, err = advanceCheckpoint(ctx, tx, commit)
		if err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit range: %w", err)
	}
	return updated, nil
}

// RewindToAncestor drops chain state above an indexed ancestor and rebuilds
// projections from the events that remain canonical.
func (r *PostgresRepository) RewindToAncestor(ctx context.Context, contractID int64, ancestorBlock int64) (*Checkpoint, error) {
	if contractID <= 0 {
		return nil, ValidationError{Field: "contractId", Message: "must be positive"}
	}
	if ancestorBlock < 0 {
		return nil, ValidationError{Field: "ancestorBlock", Message: "must not be negative, use RewindToStart instead"}
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin rewind: %w", err)
	}
	defer tx.Rollback()

	current, err := lockCheckpoint(ctx, tx, contractID)
	if err != nil {
		return nil, err
	}
	if ancestorBlock >= current.NextBlock {
		return nil, ValidationError{Field: "ancestorBlock", Message: fmt.Sprintf("must be below the checkpoint next block %d, got %d", current.NextBlock, ancestorBlock)}
	}

	var ancestorHash string
	err = tx.QueryRowContext(ctx, `
		SELECT block_hash FROM indexed_blocks
		WHERE contract_id = $1 AND block_number = $2
	`, contractID, ancestorBlock).Scan(&ancestorHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: contract %d block %d", ErrAncestorNotFound, contractID, ancestorBlock)
	}
	if err != nil {
		return nil, fmt.Errorf("read rewind ancestor: %w", err)
	}

	// Orphan events keep their rows as history; canonical state above the
	// ancestor does not.
	if err := markEventsRemovedAbove(ctx, tx, contractID, ancestorBlock); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM indexed_blocks WHERE contract_id = $1 AND block_number > $2`, contractID, ancestorBlock); err != nil {
		return nil, fmt.Errorf("delete orphaned indexed blocks: %w", err)
	}
	if err := rebuildProjectionsTx(ctx, tx, contractID); err != nil {
		return nil, err
	}

	const query = `
		UPDATE indexer_checkpoints
		SET next_block = $2, last_indexed_block = $3, last_indexed_block_hash = $4,
		    status = 'pending', last_error = NULL, updated_at = NOW()
		WHERE contract_id = $1
		RETURNING ` + checkpointColumns

	checkpoint, err := scanCheckpoint(tx.QueryRowContext(ctx, query, contractID, ancestorBlock+1, ancestorBlock, ancestorHash))
	if err != nil {
		return nil, fmt.Errorf("rewind checkpoint: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("rewind: %w", err)
	}
	return checkpoint, nil
}

// RewindToStart clears all indexed chain state for a contract and resumes at the
// stored start block.
func (r *PostgresRepository) RewindToStart(ctx context.Context, contractID int64) (*Checkpoint, error) {
	if contractID <= 0 {
		return nil, ValidationError{Field: "contractId", Message: "must be positive"}
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin rewind: %w", err)
	}
	defer tx.Rollback()

	if _, err := lockCheckpoint(ctx, tx, contractID); err != nil {
		return nil, err
	}

	if err := markAllEventsRemoved(ctx, tx, contractID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM indexed_blocks WHERE contract_id = $1`, contractID); err != nil {
		return nil, fmt.Errorf("delete indexed blocks: %w", err)
	}
	if err := rebuildProjectionsTx(ctx, tx, contractID); err != nil {
		return nil, err
	}

	// next_block returns to the stored start block, which stays authoritative.
	const query = `
		UPDATE indexer_checkpoints cp
		SET next_block = c.start_block, last_indexed_block = NULL, last_indexed_block_hash = NULL,
		    status = 'pending', last_error = NULL, updated_at = NOW()
		FROM contracts c
		WHERE cp.contract_id = $1 AND c.id = $1
		RETURNING cp.contract_id, cp.next_block, cp.last_indexed_block, cp.last_indexed_block_hash,
		          cp.status, cp.last_error, cp.updated_at
	`

	checkpoint, err := scanCheckpoint(tx.QueryRowContext(ctx, query, contractID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrContractNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("rewind checkpoint: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("rewind: %w", err)
	}
	return checkpoint, nil
}

// RebuildProjections replaces the contract projections with the state derived
// from its nonremoved events.
func (r *PostgresRepository) RebuildProjections(ctx context.Context, contractID int64) error {
	if contractID <= 0 {
		return ValidationError{Field: "contractId", Message: "must be positive"}
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin projection rebuild: %w", err)
	}
	defer tx.Rollback()

	if _, err := lockCheckpoint(ctx, tx, contractID); err != nil {
		return err
	}
	if err := rebuildProjectionsTx(ctx, tx, contractID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("projection rebuild: %w", err)
	}
	return nil
}

// lockCheckpoint serializes writers for one contract and returns the stored row.
func lockCheckpoint(ctx context.Context, tx *sql.Tx, contractID int64) (*Checkpoint, error) {
	checkpoint, err := scanCheckpoint(tx.QueryRowContext(ctx, selectCheckpointQuery+` FOR UPDATE`, contractID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrCheckpointNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("lock checkpoint: %w", err)
	}
	return checkpoint, nil
}

func markAllEventsRemoved(ctx context.Context, tx *sql.Tx, contractID int64) error {
	const query = `
		UPDATE contract_events
		SET removed = TRUE
		WHERE contract_id = $1 AND removed = FALSE
	`
	if _, err := tx.ExecContext(ctx, query, contractID); err != nil {
		return fmt.Errorf("mark events removed: %w", err)
	}
	return nil
}

func markEventsRemovedAbove(ctx context.Context, tx *sql.Tx, contractID int64, blockNumber int64) error {
	const query = `
		UPDATE contract_events
		SET removed = TRUE
		WHERE contract_id = $1 AND block_number > $2 AND removed = FALSE
	`
	if _, err := tx.ExecContext(ctx, query, contractID, blockNumber); err != nil {
		return fmt.Errorf("mark orphaned events removed: %w", err)
	}
	return nil
}

func insertBlockHeaders(ctx context.Context, tx *sql.Tx, commit RangeCommit) error {
	const insert = `
		INSERT INTO indexed_blocks (contract_id, block_number, block_hash, parent_hash, created_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (contract_id, block_number) DO NOTHING
	`
	for _, header := range commit.Blocks {
		if _, err := tx.ExecContext(ctx, insert, commit.ContractID, header.BlockNumber, header.BlockHash, header.ParentHash); err != nil {
			return fmt.Errorf("insert indexed block %d: %w", header.BlockNumber, err)
		}
	}

	// A stored hash that differs from the committed header means the stored chain
	// diverged. That is a rewind decision, never something to overwrite here.
	const verify = `
		SELECT block_number, block_hash
		FROM indexed_blocks
		WHERE contract_id = $1 AND block_number BETWEEN $2 AND $3
	`
	rows, err := tx.QueryContext(ctx, verify, commit.ContractID, commit.FromBlock, commit.ToBlock)
	if err != nil {
		return fmt.Errorf("verify indexed blocks: %w", err)
	}
	stored := make(map[int64]string)
	for rows.Next() {
		var number int64
		var hash string
		if err := rows.Scan(&number, &hash); err != nil {
			rows.Close()
			return fmt.Errorf("verify indexed blocks: %w", err)
		}
		stored[number] = hash
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("verify indexed blocks: %w", err)
	}
	rows.Close()

	for _, header := range commit.Blocks {
		if hash, ok := stored[header.BlockNumber]; ok && hash != header.BlockHash {
			return fmt.Errorf("%w: block %d stored %s, committed %s", ErrConflictingBlockHash, header.BlockNumber, hash, header.BlockHash)
		}
	}
	return nil
}

func insertEvents(ctx context.Context, tx *sql.Tx, commit RangeCommit) error {
	// A conflict on the occurrence key means the same block hash and log index are
	// canonical again. insertBlockHeaders rejects a stored hash that differs from
	// the committed header, so this can only be the same occurrence returning to
	// the canonical chain after a rewind: restore it instead of leaving it marked
	// removed, which would hide it from readers and drop it from the next rebuild.
	const insert = `
		INSERT INTO contract_events (
			contract_id, event_name, block_number, block_hash, transaction_hash,
			transaction_index, log_index, actor_address, multisig_tx_index, payload,
			removed, observed_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8::text, ''), NULLIF($9::text, '')::numeric, $10::jsonb, FALSE, NOW())
		ON CONFLICT (contract_id, block_hash, log_index) DO UPDATE SET removed = FALSE
	`

	for _, event := range commit.Events {
		payload := event.Payload
		if len(payload) == 0 {
			payload = []byte("{}")
		}
		if _, err := tx.ExecContext(ctx, insert,
			commit.ContractID, event.EventName, event.BlockNumber, event.BlockHash,
			event.TransactionHash, event.TransactionIndex, event.LogIndex,
			event.ActorAddress, event.MultisigTxIndex, string(payload),
		); err != nil {
			return fmt.Errorf("insert event %s at block %d log %d: %w", event.EventName, event.BlockNumber, event.LogIndex, err)
		}
	}
	return nil
}

func advanceCheckpoint(ctx context.Context, tx *sql.Tx, commit RangeCommit) (*Checkpoint, error) {
	var lastHash string
	for _, header := range commit.Blocks {
		if header.BlockNumber == commit.ToBlock {
			lastHash = header.BlockHash
			break
		}
	}
	if lastHash == "" {
		return nil, ValidationError{Field: "blocks", Message: fmt.Sprintf("no header for the last block %d", commit.ToBlock)}
	}

	const query = `
		UPDATE indexer_checkpoints
		SET next_block = $2, last_indexed_block = $3, last_indexed_block_hash = $4,
		    status = $5, last_error = NULL, updated_at = NOW()
		WHERE contract_id = $1
		RETURNING ` + checkpointColumns

	checkpoint, err := scanCheckpoint(tx.QueryRowContext(ctx, query,
		commit.ContractID, commit.ToBlock+1, commit.ToBlock, lastHash, string(commit.Status),
	))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrCheckpointNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("advance checkpoint: %w", err)
	}
	return checkpoint, nil
}

// applyProjections replays events in the given order onto the projections. It is
// shared by range commits and projection rebuilds so both derive the same state
// from the same events.
func applyProjections(ctx context.Context, tx *sql.Tx, contractID int64, events []Event) error {
	for _, event := range events {
		switch event.EventName {
		case EventSubmitTransaction:
			if err := projectSubmit(ctx, tx, contractID, event); err != nil {
				return err
			}
		case EventConfirmTransaction, EventRevokeConfirmation, EventExecuteTransaction:
			if event.MultisigTxIndex == "" {
				return fmt.Errorf("project %s at block %d log %d: multisig transaction index is empty", event.EventName, event.BlockNumber, event.LogIndex)
			}
			if err := ensureTransactionRow(ctx, tx, contractID, event.MultisigTxIndex); err != nil {
				return err
			}
			switch event.EventName {
			case EventConfirmTransaction:
				if err := projectConfirmation(ctx, tx, contractID, event, true); err != nil {
					return err
				}
			case EventRevokeConfirmation:
				if err := projectConfirmation(ctx, tx, contractID, event, false); err != nil {
					return err
				}
			case EventExecuteTransaction:
				if err := projectExecution(ctx, tx, contractID, event); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("project event: unsupported event %q", event.EventName)
		}
	}
	return nil
}

func projectSubmit(ctx context.Context, tx *sql.Tx, contractID int64, event Event) error {
	payload, err := DecodeSubmitPayload(event.Payload)
	if err != nil {
		return fmt.Errorf("project submit event at block %d log %d: %w", event.BlockNumber, event.LogIndex, err)
	}
	callData, err := ParseHexBytes(payload.Data)
	if err != nil {
		return fmt.Errorf("project submit event at block %d log %d: %w", event.BlockNumber, event.LogIndex, err)
	}
	if event.MultisigTxIndex == "" {
		return fmt.Errorf("project submit event at block %d log %d: multisig transaction index is empty", event.BlockNumber, event.LogIndex)
	}

	// executed is not reset here: only an Execute event establishes execution
	// state, so replaying a submit cannot undo an execution.
	const query = `
		INSERT INTO multisig_transactions (
			contract_id, multisig_tx_index, to_address, value_wei, call_data, executed,
			submitted_by, submit_evm_tx_hash, submit_block_number, created_at, updated_at
		)
		VALUES ($1, $2::numeric, $3, $4::numeric, $5, FALSE, $6, $7, $8, NOW(), NOW())
		ON CONFLICT (contract_id, multisig_tx_index) DO UPDATE SET
			to_address = EXCLUDED.to_address,
			value_wei = EXCLUDED.value_wei,
			call_data = EXCLUDED.call_data,
			submitted_by = EXCLUDED.submitted_by,
			submit_evm_tx_hash = EXCLUDED.submit_evm_tx_hash,
			submit_block_number = EXCLUDED.submit_block_number,
			-- Replaying the same range must leave the projection untouched, including
			-- its timestamp, so the timestamp moves only on a real change.
			updated_at = CASE
				WHEN multisig_transactions.to_address IS DISTINCT FROM EXCLUDED.to_address
					OR multisig_transactions.value_wei IS DISTINCT FROM EXCLUDED.value_wei
					OR multisig_transactions.call_data IS DISTINCT FROM EXCLUDED.call_data
					OR multisig_transactions.submitted_by IS DISTINCT FROM EXCLUDED.submitted_by
					OR multisig_transactions.submit_evm_tx_hash IS DISTINCT FROM EXCLUDED.submit_evm_tx_hash
					OR multisig_transactions.submit_block_number IS DISTINCT FROM EXCLUDED.submit_block_number
				THEN NOW()
				ELSE multisig_transactions.updated_at
			END
	`
	if _, err := tx.ExecContext(ctx, query,
		contractID, event.MultisigTxIndex, payload.To, payload.ValueWei, callData,
		event.ActorAddress, event.TransactionHash, event.BlockNumber,
	); err != nil {
		return fmt.Errorf("project submit event at block %d log %d: %w", event.BlockNumber, event.LogIndex, err)
	}
	return nil
}

// ensureTransactionRow creates a projection placeholder for a transaction whose
// submit event is not in the indexed range, so a confirmation or execution is
// still projected. The submit fields stay null.
func ensureTransactionRow(ctx context.Context, tx *sql.Tx, contractID int64, multisigTxIndex string) error {
	const query = `
		INSERT INTO multisig_transactions (contract_id, multisig_tx_index, created_at, updated_at)
		VALUES ($1, $2::numeric, NOW(), NOW())
		ON CONFLICT (contract_id, multisig_tx_index) DO NOTHING
	`
	if _, err := tx.ExecContext(ctx, query, contractID, multisigTxIndex); err != nil {
		return fmt.Errorf("ensure transaction projection %s: %w", multisigTxIndex, err)
	}
	return nil
}

func projectConfirmation(ctx context.Context, tx *sql.Tx, contractID int64, event Event, confirmed bool) error {
	if !IsCanonicalAddress(event.ActorAddress) {
		return fmt.Errorf("project %s at block %d log %d: owner address %q is not canonical", event.EventName, event.BlockNumber, event.LogIndex, event.ActorAddress)
	}

	query := confirmationQuery(confirmed)
	if _, err := tx.ExecContext(ctx, query,
		contractID, event.MultisigTxIndex, event.ActorAddress, event.TransactionHash, event.BlockNumber,
	); err != nil {
		return fmt.Errorf("project %s at block %d log %d: %w", event.EventName, event.BlockNumber, event.LogIndex, err)
	}
	return nil
}

func confirmationQuery(confirmed bool) string {
	// A confirmation sets the confirmed identity, a revocation clears the state
	// and records the revoke identity. The earlier confirm identity is kept, so
	// the row shows the current state and the last transition of both kinds.
	if confirmed {
		return `
			WITH parent AS (
				SELECT id FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = $2::numeric
			)
			INSERT INTO transaction_confirmations (
				multisig_transaction_id, owner_address, confirmed,
				confirmed_evm_tx_hash, confirmed_block_number, updated_at
			)
			SELECT parent.id, $3, TRUE, $4, $5, NOW() FROM parent
			ON CONFLICT (multisig_transaction_id, owner_address) DO UPDATE SET
				confirmed = TRUE,
				confirmed_evm_tx_hash = EXCLUDED.confirmed_evm_tx_hash,
				confirmed_block_number = EXCLUDED.confirmed_block_number,
				updated_at = CASE
					WHEN transaction_confirmations.confirmed IS DISTINCT FROM TRUE
						OR transaction_confirmations.confirmed_evm_tx_hash IS DISTINCT FROM EXCLUDED.confirmed_evm_tx_hash
						OR transaction_confirmations.confirmed_block_number IS DISTINCT FROM EXCLUDED.confirmed_block_number
					THEN NOW()
					ELSE transaction_confirmations.updated_at
				END
		`
	}
	return `
		WITH parent AS (
			SELECT id FROM multisig_transactions WHERE contract_id = $1 AND multisig_tx_index = $2::numeric
		)
		INSERT INTO transaction_confirmations (
			multisig_transaction_id, owner_address, confirmed,
			revoked_evm_tx_hash, revoked_block_number, updated_at
		)
		SELECT parent.id, $3, FALSE, $4, $5, NOW() FROM parent
		ON CONFLICT (multisig_transaction_id, owner_address) DO UPDATE SET
			confirmed = FALSE,
			revoked_evm_tx_hash = EXCLUDED.revoked_evm_tx_hash,
			revoked_block_number = EXCLUDED.revoked_block_number,
			updated_at = CASE
				WHEN transaction_confirmations.confirmed IS DISTINCT FROM FALSE
					OR transaction_confirmations.revoked_evm_tx_hash IS DISTINCT FROM EXCLUDED.revoked_evm_tx_hash
					OR transaction_confirmations.revoked_block_number IS DISTINCT FROM EXCLUDED.revoked_block_number
				THEN NOW()
				ELSE transaction_confirmations.updated_at
			END
	`
}

func projectExecution(ctx context.Context, tx *sql.Tx, contractID int64, event Event) error {
	const query = `
		UPDATE multisig_transactions
		SET executed = TRUE,
		    execute_evm_tx_hash = $3::text,
		    execute_block_number = $4::bigint,
		    updated_at = CASE
		    	WHEN executed IS DISTINCT FROM TRUE
		    		OR execute_evm_tx_hash IS DISTINCT FROM $3::text
		    		OR execute_block_number IS DISTINCT FROM $4::bigint
		    	THEN NOW()
		    	ELSE updated_at
		    END
		WHERE contract_id = $1 AND multisig_tx_index = $2::numeric
	`
	if _, err := tx.ExecContext(ctx, query,
		contractID, event.MultisigTxIndex, event.TransactionHash, event.BlockNumber,
	); err != nil {
		return fmt.Errorf("project %s at block %d log %d: %w", event.EventName, event.BlockNumber, event.LogIndex, err)
	}
	return nil
}

// rebuildProjectionsTx replaces the projections with the state derived from the
// contract's nonremoved events replayed in canonical order.
func rebuildProjectionsTx(ctx context.Context, tx *sql.Tx, contractID int64) error {
	const deleteConfirmations = `
		DELETE FROM transaction_confirmations
		WHERE multisig_transaction_id IN (SELECT id FROM multisig_transactions WHERE contract_id = $1)
	`
	if _, err := tx.ExecContext(ctx, deleteConfirmations, contractID); err != nil {
		return fmt.Errorf("clear transaction confirmations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM multisig_transactions WHERE contract_id = $1`, contractID); err != nil {
		return fmt.Errorf("clear multisig transactions: %w", err)
	}

	const query = `
		SELECT event_name, block_number, block_hash, transaction_hash, transaction_index, log_index,
		       COALESCE(actor_address, ''), COALESCE(multisig_tx_index::text, ''), payload::text
		FROM contract_events
		WHERE contract_id = $1 AND removed = FALSE
		ORDER BY block_number, transaction_index, log_index
	`
	rows, err := tx.QueryContext(ctx, query, contractID)
	if err != nil {
		return fmt.Errorf("read canonical events: %w", err)
	}

	var events []Event
	for rows.Next() {
		event := Event{ContractID: contractID}
		var payload string
		if err := rows.Scan(
			&event.EventName, &event.BlockNumber, &event.BlockHash, &event.TransactionHash,
			&event.TransactionIndex, &event.LogIndex, &event.ActorAddress, &event.MultisigTxIndex, &payload,
		); err != nil {
			rows.Close()
			return fmt.Errorf("scan canonical event: %w", err)
		}
		event.Payload = []byte(payload)
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("read canonical events: %w", err)
	}
	rows.Close()

	return applyProjections(ctx, tx, contractID, events)
}

type checkpointScanner interface {
	Scan(dest ...any) error
}

func scanCheckpoint(row checkpointScanner) (*Checkpoint, error) {
	var (
		checkpoint    Checkpoint
		status        string
		lastBlock     sql.NullInt64
		lastBlockHash sql.NullString
		lastError     sql.NullString
	)
	if err := row.Scan(
		&checkpoint.ContractID, &checkpoint.NextBlock, &lastBlock, &lastBlockHash,
		&status, &lastError, &checkpoint.UpdatedAt,
	); err != nil {
		return nil, err
	}

	checkpoint.Status = CheckpointStatus(status)
	if lastBlock.Valid {
		value := lastBlock.Int64
		checkpoint.LastIndexedBlock = &value
	}
	if lastBlockHash.Valid {
		value := lastBlockHash.String
		checkpoint.LastIndexedBlockHash = &value
	}
	if lastError.Valid {
		value := lastError.String
		checkpoint.LastError = &value
	}
	return &checkpoint, nil
}
