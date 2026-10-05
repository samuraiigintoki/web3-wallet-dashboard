// Package indexer owns the persistence layer of the event indexer: canonical
// block rows, decoded event history, multisig transaction and confirmation
// projections, and one checkpoint per contract deployment.
//
// The package stores data only. It performs no RPC calls, holds no worker and
// exposes no HTTP routes. The scanner that reads ranges from the chain and calls
// this repository is wired in a later block.
package indexer

import (
	"fmt"
	"math/big"
	"regexp"
	"time"
)

// CheckpointStatus is the persisted indexing state of one contract deployment.
type CheckpointStatus string

const (
	// StatusPending means the contract has not been scanned up to its start
	// block yet.
	StatusPending CheckpointStatus = "pending"
	// StatusRunning means a range is currently being processed.
	StatusRunning CheckpointStatus = "running"
	// StatusIdle means the contract is caught up to the safe head.
	StatusIdle CheckpointStatus = "idle"
	// StatusError means the last run failed and last_error explains why.
	StatusError CheckpointStatus = "error"
	// StatusDisabled means the global contracts.indexing_enabled flag is false.
	StatusDisabled CheckpointStatus = "disabled"
	// StatusUnsupported means the contract chain is not served by the configured
	// RPC endpoint and must not be queried through it.
	StatusUnsupported CheckpointStatus = "unsupported"
)

// checkpointStatuses is the full set accepted by the database CHECK constraint.
var checkpointStatuses = [...]CheckpointStatus{
	StatusPending,
	StatusRunning,
	StatusIdle,
	StatusError,
	StatusDisabled,
	StatusUnsupported,
}

// Valid reports whether the status is one of the six persisted values.
func (s CheckpointStatus) Valid() bool {
	for _, candidate := range checkpointStatuses {
		if s == candidate {
			return true
		}
	}
	return false
}

// Supported event names emitted by the deployed MultiSigWallet contract. The
// contract has no receive or fallback event, so there is no deposit event.
const (
	EventSubmitTransaction  = "SubmitTransaction"
	EventConfirmTransaction = "ConfirmTransaction"
	EventRevokeConfirmation = "RevokeConfirmation"
	EventExecuteTransaction = "ExecuteTransaction"
)

var supportedEventNames = [...]string{
	EventSubmitTransaction,
	EventConfirmTransaction,
	EventRevokeConfirmation,
	EventExecuteTransaction,
}

// IsSupportedEventName reports whether the name is one of the four indexed events.
func IsSupportedEventName(name string) bool {
	for _, candidate := range supportedEventNames {
		if name == candidate {
			return true
		}
	}
	return false
}

// WatchTarget is one global contract deployment the indexer may follow.
type WatchTarget struct {
	ContractID      int64
	ChainID         int64
	Address         string
	StartBlock      int64
	IndexingEnabled bool
}

// BlockHeader is the canonical identity of one block for one contract.
type BlockHeader struct {
	BlockNumber int64
	BlockHash   string
	ParentHash  string
}

// Event is one decoded contract event row.
type Event struct {
	ContractID       int64
	EventName        string
	BlockNumber      int64
	BlockHash        string
	TransactionHash  string
	TransactionIndex int
	LogIndex         int
	ActorAddress     string
	// MultisigTxIndex is the contract transaction index as a canonical decimal
	// string, because the field is a uint256. Empty when the event has none.
	MultisigTxIndex string
	// Payload is normalized JSON. Submit payloads are produced by
	// EncodeSubmitPayload. Empty means an empty object.
	Payload []byte
	Removed bool
}

// RangeCommit is one inclusive block range ready to be committed atomically.
// Blocks must cover every block in the range and Events must be in canonical
// order: block number, then transaction index, then log index.
type RangeCommit struct {
	ContractID int64
	FromBlock  int64
	ToBlock    int64
	Blocks     []BlockHeader
	Events     []Event
	// Status recorded on the checkpoint after the commit: StatusIdle when the
	// contract is caught up to the safe head, StatusPending when more ranges remain.
	Status CheckpointStatus
}

// Checkpoint is the persisted progress and status of one contract deployment.
type Checkpoint struct {
	ContractID           int64
	NextBlock            int64
	LastIndexedBlock     *int64
	LastIndexedBlockHash *string
	Status               CheckpointStatus
	LastError            *string
	UpdatedAt            time.Time
}

// Validate rejects a commit that could not be applied safely: an impossible
// range, missing or non-contiguous block headers, a status that is not a range
// outcome, or an event outside the committed range.
func (c RangeCommit) Validate() error {
	if c.ContractID <= 0 {
		return ValidationError{Field: "contractId", Message: "must be positive"}
	}
	if c.FromBlock < 0 {
		return ValidationError{Field: "fromBlock", Message: "must not be negative"}
	}
	if c.ToBlock < c.FromBlock {
		return ValidationError{Field: "toBlock", Message: fmt.Sprintf("must not be below fromBlock %d, got %d", c.FromBlock, c.ToBlock)}
	}
	if c.Status != StatusIdle && c.Status != StatusPending {
		return ValidationError{Field: "status", Message: fmt.Sprintf("must be %q or %q, got %q", StatusIdle, StatusPending, c.Status)}
	}

	wantBlocks := c.ToBlock - c.FromBlock + 1
	if int64(len(c.Blocks)) != wantBlocks {
		return ValidationError{Field: "blocks", Message: fmt.Sprintf("range %d..%d needs %d headers, got %d", c.FromBlock, c.ToBlock, wantBlocks, len(c.Blocks))}
	}
	blockHashes := make(map[int64]string, len(c.Blocks))
	for i, header := range c.Blocks {
		wantNumber := c.FromBlock + int64(i)
		if header.BlockNumber != wantNumber {
			return ValidationError{Field: "blocks", Message: fmt.Sprintf("position %d: expected contiguous block %d, got %d", i, wantNumber, header.BlockNumber)}
		}
		if !IsCanonicalHash(header.BlockHash) {
			return ValidationError{Field: "blocks", Message: fmt.Sprintf("block %d: block hash is not a canonical 32-byte hash", header.BlockNumber)}
		}
		if !IsCanonicalHash(header.ParentHash) {
			return ValidationError{Field: "blocks", Message: fmt.Sprintf("block %d: parent hash is not a canonical 32-byte hash", header.BlockNumber)}
		}
		blockHashes[header.BlockNumber] = header.BlockHash
	}

	for i, event := range c.Events {
		if event.ContractID != c.ContractID {
			return ValidationError{Field: "events", Message: fmt.Sprintf("position %d: event contract %d does not match commit contract %d", i, event.ContractID, c.ContractID)}
		}
		if event.BlockNumber < c.FromBlock || event.BlockNumber > c.ToBlock {
			return ValidationError{Field: "events", Message: fmt.Sprintf("position %d: block %d is outside the committed range", i, event.BlockNumber)}
		}
		if hash, ok := blockHashes[event.BlockNumber]; !ok || hash != event.BlockHash {
			return ValidationError{Field: "events", Message: fmt.Sprintf("position %d: block hash of block %d does not match the committed header", i, event.BlockNumber)}
		}
		if event.Removed {
			return ValidationError{Field: "events", Message: fmt.Sprintf("position %d: a committed event must not already be marked removed", i)}
		}
		if err := event.Validate(); err != nil {
			return err
		}
	}

	for i := 1; i < len(c.Events); i++ {
		if compareEventOrder(c.Events[i-1], c.Events[i]) > 0 {
			return ValidationError{Field: "events", Message: fmt.Sprintf("position %d: events are not in canonical order", i)}
		}
	}

	return nil
}

// Validate rejects an event row that cannot be stored or projected safely.
func (e Event) Validate() error {
	if e.ContractID <= 0 {
		return ValidationError{Field: "contractId", Message: "must be positive"}
	}
	if !IsSupportedEventName(e.EventName) {
		return ValidationError{Field: "eventName", Message: fmt.Sprintf("unsupported event %q", e.EventName)}
	}
	if e.BlockNumber < 0 {
		return ValidationError{Field: "blockNumber", Message: "must not be negative"}
	}
	if !IsCanonicalHash(e.BlockHash) {
		return ValidationError{Field: "blockHash", Message: "must be a lowercase 0x-prefixed 32-byte hash"}
	}
	if !IsCanonicalHash(e.TransactionHash) {
		return ValidationError{Field: "transactionHash", Message: "must be a lowercase 0x-prefixed 32-byte hash"}
	}
	if e.TransactionIndex < 0 {
		return ValidationError{Field: "transactionIndex", Message: "must not be negative"}
	}
	if e.LogIndex < 0 {
		return ValidationError{Field: "logIndex", Message: "must not be negative"}
	}
	if e.ActorAddress != "" && !IsCanonicalAddress(e.ActorAddress) {
		return ValidationError{Field: "actorAddress", Message: "must be a lowercase 0x-prefixed 20-byte address"}
	}
	if e.MultisigTxIndex != "" {
		if _, err := ParseUint256Decimal(e.MultisigTxIndex); err != nil {
			return ValidationError{Field: "multisigTxIndex", Message: err.Error()}
		}
	}
	if len(e.Payload) > 0 {
		if _, err := DecodePayloadObject(e.Payload); err != nil {
			return ValidationError{Field: "payload", Message: err.Error()}
		}
	}
	return nil
}

// compareEventOrder orders events by block number, transaction index and log
// index, which is the canonical replay order used by projection rebuilds.
func compareEventOrder(a, b Event) int {
	switch {
	case a.BlockNumber != b.BlockNumber:
		if a.BlockNumber < b.BlockNumber {
			return -1
		}
		return 1
	case a.TransactionIndex != b.TransactionIndex:
		if a.TransactionIndex < b.TransactionIndex {
			return -1
		}
		return 1
	case a.LogIndex != b.LogIndex:
		if a.LogIndex < b.LogIndex {
			return -1
		}
		return 1
	default:
		return 0
	}
}

var (
	canonicalAddressPattern = regexp.MustCompile(`^0x[0-9a-f]{40}$`)
	canonicalHashPattern    = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
	uint256DecimalPattern   = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)
)

// IsCanonicalAddress reports whether the value is a lowercase 0x-prefixed
// 20-byte address, the one representation stored by this package.
func IsCanonicalAddress(address string) bool {
	return canonicalAddressPattern.MatchString(address)
}

// IsCanonicalHash reports whether the value is a lowercase 0x-prefixed
// 32-byte hash.
func IsCanonicalHash(hash string) bool {
	return canonicalHashPattern.MatchString(hash)
}

// ParseUint256Decimal parses a canonical decimal string into a uint256 value.
// Leading zeros, signs and values above 2^256-1 are rejected.
func ParseUint256Decimal(value string) (*big.Int, error) {
	if !uint256DecimalPattern.MatchString(value) {
		return nil, fmt.Errorf("%q is not a canonical unsigned 256-bit decimal string", value)
	}
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok {
		return nil, fmt.Errorf("%q is not a valid decimal integer", value)
	}
	if parsed.BitLen() > 256 {
		return nil, fmt.Errorf("%q exceeds 256 bits", value)
	}
	return parsed, nil
}

// FormatUint256 renders a uint256 value as a canonical decimal string for
// storage. Negative and oversized values are rejected.
func FormatUint256(value *big.Int) (string, error) {
	if value == nil {
		return "", fmt.Errorf("value is nil")
	}
	if value.Sign() < 0 {
		return "", fmt.Errorf("value %s is negative", value)
	}
	if value.BitLen() > 256 {
		return "", fmt.Errorf("value %s exceeds 256 bits", value)
	}
	return value.String(), nil
}
