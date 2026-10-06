package indexer

import (
	"context"
	"fmt"
	"math/big"
)

// EventMetadata is the plain-value chain identity of one decoded log. It is the
// part of an event that comes from the chain rather than from decoding.
type EventMetadata struct {
	BlockNumber      int64
	BlockHash        string
	TransactionHash  string
	TransactionIndex int
	LogIndex         int
}

// NewSubmitTransactionEvent builds the event row for a decoded
// SubmitTransaction log and encodes its normalized payload. The multisig
// transaction index is stored as a canonical decimal string because the
// contract field is a uint256.
func NewSubmitTransactionEvent(contractID int64, meta EventMetadata, owner string, multisigTxIndex uint64, to string, valueWei *big.Int, callData []byte) (Event, error) {
	payload, err := EncodeSubmitPayload(to, valueWei, callData)
	if err != nil {
		return Event{}, ValidationError{Field: "payload", Message: err.Error()}
	}
	event := Event{
		ContractID:       contractID,
		EventName:        EventSubmitTransaction,
		BlockNumber:      meta.BlockNumber,
		BlockHash:        meta.BlockHash,
		TransactionHash:  meta.TransactionHash,
		TransactionIndex: meta.TransactionIndex,
		LogIndex:         meta.LogIndex,
		ActorAddress:     owner,
		MultisigTxIndex:  fmt.Sprintf("%d", multisigTxIndex),
		Payload:          payload,
	}
	if err := event.Validate(); err != nil {
		return Event{}, err
	}
	return event, nil
}

// NewOwnerEvent builds the event row for a decoded ConfirmTransaction,
// RevokeConfirmation or ExecuteTransaction log. Those events carry an owner and
// a transaction index only, so the payload is an empty object.
func NewOwnerEvent(contractID int64, meta EventMetadata, eventName string, owner string, multisigTxIndex uint64) (Event, error) {
	switch eventName {
	case EventSubmitTransaction:
		return Event{}, ValidationError{Field: "eventName", Message: "use NewSubmitTransactionEvent for SubmitTransaction"}
	case EventConfirmTransaction, EventRevokeConfirmation, EventExecuteTransaction:
	default:
		return Event{}, ValidationError{Field: "eventName", Message: fmt.Sprintf("unsupported event %q", eventName)}
	}

	event := Event{
		ContractID:       contractID,
		EventName:        eventName,
		BlockNumber:      meta.BlockNumber,
		BlockHash:        meta.BlockHash,
		TransactionHash:  meta.TransactionHash,
		TransactionIndex: meta.TransactionIndex,
		LogIndex:         meta.LogIndex,
		ActorAddress:     owner,
		MultisigTxIndex:  fmt.Sprintf("%d", multisigTxIndex),
	}
	if err := event.Validate(); err != nil {
		return Event{}, err
	}
	return event, nil
}

// Repository is the persistence port of the indexer. Every method is safe to
// call with a caller context and owns only SQL, never HTTP or RPC behavior.
//
// One writer per contract is assumed. Commits and rewinds take a row lock on
// the contract checkpoint, so two concurrent writers cannot interleave, but the
// caller must still serialize its own scanning per contract.
type Repository interface {
	// ListWatchTargets returns every global contract deployment with its stored
	// start block and global indexing flag. The list is deliberately independent
	// of user_contracts: a deployment is indexed once no matter how many users
	// track it, and it is still indexed when no user does. Callers select the
	// chain served by their RPC and skip disabled rows.
	ListWatchTargets(ctx context.Context) ([]WatchTarget, error)

	// EnsureCheckpoint creates the checkpoint for a contract when it is missing,
	// with next_block set to the stored contracts.start_block, and otherwise
	// returns the existing row unchanged so a resume never restarts or skips a
	// range. The stored start block is authoritative, not a caller-supplied one.
	EnsureCheckpoint(ctx context.Context, contractID int64) (*Checkpoint, error)

	// GetCheckpoint returns the stored checkpoint or ErrCheckpointNotFound.
	GetCheckpoint(ctx context.Context, contractID int64) (*Checkpoint, error)

	// SetCheckpointStatus records a status outside a range commit, for example
	// running before a scan, idle once caught up, or error with a sanitized
	// message. lastError must be empty unless status is StatusError.
	SetCheckpointStatus(ctx context.Context, contractID int64, status CheckpointStatus, lastError string) (*Checkpoint, error)

	// ResetRunningCheckpoints returns every checkpoint left in StatusRunning by a
	// previous process to StatusPending and reports how many rows changed. It is
	// called once on startup.
	ResetRunningCheckpoints(ctx context.Context) (int64, error)

	// ListIndexedBlocks returns the stored canonical block rows of one contract
	// for an inclusive block window, ordered by descending block number. It is
	// read-only and exists so a caller can walk stored chain state back to a
	// common ancestor after a reorganization. The window is bounded: fromBlock
	// and toBlock must be ordered and must span at most maxIndexedBlockWindow
	// blocks, because a larger window is a caller bug rather than something to
	// clamp. A window with no stored rows returns an empty slice and no error,
	// which is how the caller learns that the stored history ends there.
	ListIndexedBlocks(ctx context.Context, contractID int64, fromBlock, toBlock int64) ([]BlockHeader, error)

	// ListContractEvents returns one page of a contract's canonical events,
	// newest first by block number, transaction index and log index, plus the
	// total number of canonical events. Rows marked removed are excluded from
	// both the page and the count, and the page is validated the way every other
	// API collection validates it. It is read-only.
	ListContractEvents(ctx context.Context, contractID int64, page EventPage) ([]Event, int, error)

	// CommitRange applies one inclusive block range in a single transaction:
	// canonical block rows, event rows, projection changes and checkpoint
	// advancement commit together or not at all. Repeating a commit is
	// idempotent, a commit above next_block returns ErrCheckpointGap, and a
	// stored block hash that differs from the committed header returns
	// ErrConflictingBlockHash.
	CommitRange(ctx context.Context, commit RangeCommit) (*Checkpoint, error)

	// RewindToAncestor discards chain state above an indexed ancestor: later
	// events are marked removed and kept as history, later canonical block rows
	// are deleted, projections are rebuilt from the remaining nonremoved events,
	// and the checkpoint resumes at ancestorBlock + 1 with StatusPending. The
	// ancestor must already be indexed and ancestorBlock must not be negative;
	// use RewindToStart when no stored ancestor remains.
	RewindToAncestor(ctx context.Context, contractID int64, ancestorBlock int64) (*Checkpoint, error)

	// RewindToStart discards all indexed chain state for a contract: every event
	// is marked removed and kept as history, every canonical block row is
	// deleted, projections are cleared, and the checkpoint resumes at the stored
	// contracts.start_block with no last indexed block.
	RewindToStart(ctx context.Context, contractID int64) (*Checkpoint, error)

	// RebuildProjections replaces the contract projections with the state
	// derived from its nonremoved events replayed in canonical order by block
	// number, transaction index and log index. The result depends only on stored
	// events, so it is repeatable.
	RebuildProjections(ctx context.Context, contractID int64) error
}
