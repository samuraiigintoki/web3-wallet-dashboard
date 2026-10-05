package indexer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/evm"
)

// ChainReader is the slice of the EVM client the scanner consumes. *evm.Client
// satisfies it, and tests substitute a fake. Every method takes the caller's
// context and makes one attempt, and a single attempt stays inside the client:
// the scanner owns retry, and it repeats the whole range operation rather than
// individual reads.
type ChainReader interface {
	BlockNumber(ctx context.Context) (uint64, error)
	BlockHeaders(ctx context.Context, blockNumbers []uint64) ([]evm.BlockHeader, error)
	FilterLogs(ctx context.Context, filter evm.LogFilter) ([]evm.RawLog, error)
}

const (
	// maxRangeBlocks caps one scanned range, inclusive. It matches the EVM
	// client's header batch cap, so one range needs exactly one batch and one
	// log read.
	maxRangeBlocks int64 = 100

	// safeHeadConfirmations is the reversible confirmation heuristic: 12
	// confirmations including the head block itself. It is not protocol
	// finality, and it is not the reorg boundary: the stored tip is compared
	// with the canonical header on every run, so a mismatch deeper than this
	// window is still corrected.
	safeHeadConfirmations uint64 = 12

	// statusWriteTimeout bounds the status write issued after a failed range.
	// That write is detached from the run context, so a canceled or expired run
	// can still record why it failed without hanging the shutdown path.
	statusWriteTimeout = 5 * time.Second

	// maxErrorMessage bounds the text stored in a checkpoint's last_error and
	// written to a log line.
	maxErrorMessage = 400

	// redactedMarker replaces credential material in a message.
	redactedMarker = "[redacted]"
)

// keyedURLPattern matches a provider URL path that carries an API key in the
// path, keeping the host readable so a failure message stays diagnosable.
var keyedURLPattern = regexp.MustCompile(`(?i)(https?://[^\s"'<>/]+/(?:v2|v3|api)/)[A-Za-z0-9_\-]+`)

var whitespacePattern = regexp.MustCompile(`\s+`)

// SanitizedError carries a failure with a message that is safe to log and
// persist: configured secrets are replaced, keyed URLs are redacted and the
// text is bounded. Unwrap keeps the original error, so errors.Is and errors.As
// keep working for callers that need to classify a failure.
type SanitizedError struct {
	message string
	cause   error
}

func (e *SanitizedError) Error() string { return e.message }

func (e *SanitizedError) Unwrap() error { return e.cause }

// SanitizeError wraps err so its message can be logged or stored without
// leaking a configured secret. It returns nil for a nil error and writes
// nothing itself.
func SanitizeError(err error, secrets ...string) error {
	if err == nil {
		return nil
	}
	return &SanitizedError{message: SanitizeMessage(err.Error(), secrets...), cause: err}
}

// SanitizeMessage replaces each secret, redacts a keyed provider URL, collapses
// whitespace and truncates the result on a rune boundary.
func SanitizeMessage(message string, secrets ...string) string {
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		message = strings.ReplaceAll(message, secret, redactedMarker)
	}
	message = keyedURLPattern.ReplaceAllString(message, redactedMarker)
	message = strings.TrimSpace(whitespacePattern.ReplaceAllString(message, " "))
	if len(message) > maxErrorMessage {
		message = truncateRunes(message, maxErrorMessage) + "..."
	}
	return message
}

func truncateRunes(message string, limit int) string {
	cut := message[:limit]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}

// Job scans globally enabled deployments forward and commits bounded ranges
// through the repository. It implements the worker's Job interface, so the
// worker owns the tick, the run timeout and the stop handshake.
//
// One run processes at most one range for one contract, sequentially. There are
// no per-contract goroutines and no concurrent ranges, so a second run cannot
// overlap the first.
type Job struct {
	repo    Repository
	reader  ChainReader
	chainID int64
	// rpcURL is kept only to redact it from failure messages. It is never
	// logged, stored or returned.
	rpcURL string
	logger *slog.Logger

	// cursor is the in-memory rotation position over the eligible contracts.
	// Restarting resumes from the first contract, which is harmless because a
	// checkpoint is never processed twice.
	cursor int

	// Retry policy for one range operation. The fields are set from the package
	// defaults and replaced by tests, which is how the backoff schedule is
	// asserted without waiting on wall-clock delays.
	attempts int
	backoff  []time.Duration
	wait     func(context.Context, time.Duration) error
}

// NewJob builds the scanner. The chain ID must be the chain the reader was
// verified against: deployments on any other chain are never scanned.
func NewJob(repo Repository, reader ChainReader, chainID int64, rpcURL string, logger *slog.Logger) (*Job, error) {
	if repo == nil {
		return nil, errors.New("indexer: repository is required")
	}
	if reader == nil {
		return nil, errors.New("indexer: chain reader is required")
	}
	if chainID <= 0 {
		return nil, fmt.Errorf("indexer: chain ID must be positive, got %d", chainID)
	}
	if logger == nil {
		return nil, errors.New("indexer: logger is required")
	}
	return &Job{
		repo:     repo,
		reader:   reader,
		chainID:  chainID,
		rpcURL:   rpcURL,
		logger:   logger,
		attempts: retryAttempts,
		backoff:  retryBackoff,
		wait:     waitForRetry,
	}, nil
}

// Run processes at most one range for one eligible contract and returns. The
// safe head is the latest block minus 11, which yields 12 confirmations
// including the head block itself. A chain that is younger than the
// confirmation window produces no work rather than an unsigned underflow.
func (j *Job) Run(ctx context.Context) error {
	latest, err := j.reader.BlockNumber(ctx)
	if err != nil {
		return j.wrap(fmt.Errorf("read latest block: %w", err))
	}
	if latest < safeHeadConfirmations-1 {
		return nil
	}
	safeHead := int64(latest - (safeHeadConfirmations - 1))

	targets, err := j.repo.ListWatchTargets(ctx)
	if err != nil {
		return j.wrap(fmt.Errorf("read watch set: %w", err))
	}
	eligible := make([]WatchTarget, 0, len(targets))
	for _, target := range targets {
		// The global flag and the chain both come from the contracts table. A
		// disabled deployment and a deployment on a chain this RPC endpoint does
		// not serve are skipped without a status write and without a request.
		if !target.IndexingEnabled || target.ChainID != j.chainID {
			continue
		}
		eligible = append(eligible, target)
	}
	if len(eligible) == 0 {
		return nil
	}

	// Rotate over the eligible contracts so a busy deployment cannot starve the
	// others. Caught-up contracts are refreshed and skipped; the first contract
	// with work gets the single range this run is allowed.
	start := j.cursor % len(eligible)
	for offset := 0; offset < len(eligible); offset++ {
		position := (start + offset) % len(eligible)
		scanned, err := j.scanContract(ctx, eligible[position], safeHead)
		if err != nil {
			return err
		}
		if scanned {
			j.cursor = (position + 1) % len(eligible)
			return nil
		}
	}
	return nil
}

// scanContract refreshes one checkpoint, corrects the stored chain state when
// the chain has moved under it, and then processes one range. It reports whether
// a range was committed.
func (j *Job) scanContract(ctx context.Context, target WatchTarget, safeHead int64) (bool, error) {
	checkpoint, err := j.repo.EnsureCheckpoint(ctx, target.ContractID)
	if err != nil {
		return false, j.wrap(fmt.Errorf("ensure checkpoint for contract %d: %w", target.ContractID, err))
	}

	// A stored tip the chain no longer has is corrected before anything else,
	// including before a checkpoint that looks caught up is left alone: the
	// stored state above the fork is what a later commit would otherwise build
	// on.
	checkpoint, err = j.correctChainState(ctx, target, checkpoint)
	if err != nil {
		return false, j.failRange(ctx, target.ContractID, err)
	}

	if checkpoint.NextBlock > safeHead {
		if checkpoint.Status == StatusIdle {
			return false, nil
		}
		if _, err := j.repo.SetCheckpointStatus(ctx, target.ContractID, StatusIdle, ""); err != nil {
			return false, j.wrap(fmt.Errorf("mark contract %d idle: %w", target.ContractID, err))
		}
		j.logger.Info("indexer caught up to the safe head",
			"contractId", target.ContractID, "nextBlock", checkpoint.NextBlock, "safeHead", safeHead)
		return false, nil
	}

	fromBlock := checkpoint.NextBlock
	toBlock := fromBlock + maxRangeBlocks - 1
	if toBlock > safeHead {
		toBlock = safeHead
	}

	if _, err := j.repo.SetCheckpointStatus(ctx, target.ContractID, StatusRunning, ""); err != nil {
		return false, j.wrap(fmt.Errorf("mark contract %d running: %w", target.ContractID, err))
	}

	status := StatusPending
	if toBlock == safeHead {
		status = StatusIdle
	}
	commit := RangeCommit{
		ContractID: target.ContractID,
		FromBlock:  fromBlock,
		ToBlock:    toBlock,
		Status:     status,
	}

	// One attempt is the whole range: read, verify, decode and commit. A
	// transient failure repeats all of it, so the job never resumes from a
	// partially successful attempt, and nothing is written between attempts:
	// the status above was recorded once, before the first one. Repeating the
	// commit is safe because the repository applies a range idempotently.
	err = j.runWithRetry(ctx, target.ContractID, func(ctx context.Context) error {
		headers, logs, err := j.readRange(ctx, target, fromBlock, toBlock)
		if err != nil {
			return err
		}
		blocks, err := blockHeadersFromEVM(headers)
		if err != nil {
			return err
		}
		events, err := decodeRange(target.ContractID, target.Address, blocks, logs)
		if err != nil {
			return err
		}

		commit.Blocks = blocks
		commit.Events = events
		if _, err := j.repo.CommitRange(ctx, commit); err != nil {
			return fmt.Errorf("commit range %d..%d: %w", fromBlock, toBlock, err)
		}
		return nil
	})
	if err != nil {
		return false, j.failRange(ctx, target.ContractID, err)
	}

	j.logger.Info("indexer range committed",
		"contractId", target.ContractID, "fromBlock", fromBlock, "toBlock", toBlock,
		"events", len(commit.Events), "status", status, "safeHead", safeHead)
	return true, nil
}

// readRange fetches the headers for one inclusive range with a single batched
// request and then the logs for the same window.
func (j *Job) readRange(ctx context.Context, target WatchTarget, fromBlock, toBlock int64) ([]evm.BlockHeader, []evm.RawLog, error) {
	numbers := make([]uint64, 0, toBlock-fromBlock+1)
	for number := fromBlock; number <= toBlock; number++ {
		numbers = append(numbers, uint64(number))
	}

	headers, err := j.reader.BlockHeaders(ctx, numbers)
	if err != nil {
		return nil, nil, fmt.Errorf("read headers for %d..%d: %w", fromBlock, toBlock, err)
	}

	// The filter is always built through evm.NewLogFilter, so a scan requests
	// every supported event topic and can never narrow its own coverage.
	logs, err := j.reader.FilterLogs(ctx, evm.NewLogFilter(uint64(fromBlock), uint64(toBlock), target.Address))
	if err != nil {
		return nil, nil, fmt.Errorf("read logs for %d..%d: %w", fromBlock, toBlock, err)
	}
	return headers, logs, nil
}

// blockHeadersFromEVM converts the reader's headers into the stored shape,
// rejecting a height that does not fit rather than truncating it.
func blockHeadersFromEVM(headers []evm.BlockHeader) ([]BlockHeader, error) {
	blocks := make([]BlockHeader, 0, len(headers))
	for _, header := range headers {
		number, err := int64FromUint64(header.Number, "block number")
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, BlockHeader{
			BlockNumber: number,
			BlockHash:   header.Hash,
			ParentHash:  header.ParentHash,
		})
	}
	return blocks, nil
}

// decodeRange verifies the returned logs against the fetched headers, orders
// them canonically and decodes them into stored events.
func decodeRange(contractID int64, address string, headers []BlockHeader, logs []evm.RawLog) ([]Event, error) {
	hashByNumber := make(map[int64]string, len(headers))
	for _, header := range headers {
		hashByNumber[header.BlockNumber] = header.BlockHash
	}

	for i, raw := range logs {
		blockNumber, err := int64FromUint64(raw.BlockNumber, "block number")
		if err != nil {
			return nil, fmt.Errorf("log %d: %w", i, err)
		}
		hash, ok := hashByNumber[blockNumber]
		if !ok {
			return nil, fmt.Errorf("log %d at block %d has no fetched header", i, raw.BlockNumber)
		}
		if !strings.EqualFold(hash, raw.BlockHash) {
			return nil, fmt.Errorf("log %d at block %d has block hash %s, the header says %s", i, raw.BlockNumber, raw.BlockHash, hash)
		}
		if raw.Removed {
			return nil, fmt.Errorf("log %d at block %d is marked removed and cannot be committed as canonical", i, raw.BlockNumber)
		}
	}

	// Canonical order: block number, then transaction index, then log index.
	// The endpoint's order is not guaranteed, and the repository replays
	// projections in the order it receives.
	ordered := slices.Clone(logs)
	slices.SortStableFunc(ordered, compareRawLogs)

	decoder, err := evm.NewEventDecoder(address)
	if err != nil {
		return nil, fmt.Errorf("build event decoder for %s: %w", address, err)
	}

	events := make([]Event, 0, len(ordered))
	for i, raw := range ordered {
		decoded, err := decoder.Decode(raw)
		if err != nil {
			return nil, fmt.Errorf("decode log %d at block %d: %w", i, raw.BlockNumber, err)
		}
		event, err := eventFromDecoded(contractID, decoded)
		if err != nil {
			return nil, fmt.Errorf("map log %d at block %d: %w", i, raw.BlockNumber, err)
		}
		events = append(events, event)
	}
	return events, nil
}

func compareRawLogs(a, b evm.RawLog) int {
	switch {
	case a.BlockNumber != b.BlockNumber:
		return compareUint64(a.BlockNumber, b.BlockNumber)
	case a.TransactionIndex != b.TransactionIndex:
		return compareUint64(a.TransactionIndex, b.TransactionIndex)
	default:
		return compareUint64(a.LogIndex, b.LogIndex)
	}
}

func compareUint64(a, b uint64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

// eventFromDecoded maps one decoded EVM event onto the stored event shape.
func eventFromDecoded(contractID int64, decoded evm.DecodedEvent) (Event, error) {
	switch event := decoded.(type) {
	case evm.SubmitTransactionEvent:
		meta, err := eventMetadata(event.Metadata)
		if err != nil {
			return Event{}, err
		}
		return NewSubmitTransactionEvent(contractID, meta, event.Owner, event.MultisigTxIndex, event.To, event.ValueWei, event.Data)
	case evm.ConfirmTransactionEvent:
		meta, err := eventMetadata(event.Metadata)
		if err != nil {
			return Event{}, err
		}
		return NewOwnerEvent(contractID, meta, EventConfirmTransaction, event.Owner, event.MultisigTxIndex)
	case evm.RevokeConfirmationEvent:
		meta, err := eventMetadata(event.Metadata)
		if err != nil {
			return Event{}, err
		}
		return NewOwnerEvent(contractID, meta, EventRevokeConfirmation, event.Owner, event.MultisigTxIndex)
	case evm.ExecuteTransactionEvent:
		meta, err := eventMetadata(event.Metadata)
		if err != nil {
			return Event{}, err
		}
		return NewOwnerEvent(contractID, meta, EventExecuteTransaction, event.Owner, event.MultisigTxIndex)
	default:
		return Event{}, fmt.Errorf("unsupported decoded event %T", decoded)
	}
}

// eventMetadata converts the decoder's unsigned block identity into the stored
// signed shape, rejecting a value that does not fit rather than truncating it.
func eventMetadata(meta evm.EventMetadata) (EventMetadata, error) {
	blockNumber, err := int64FromUint64(meta.BlockNumber, "block number")
	if err != nil {
		return EventMetadata{}, err
	}
	transactionIndex, err := intFromUint64(meta.TransactionIndex, "transaction index")
	if err != nil {
		return EventMetadata{}, err
	}
	logIndex, err := intFromUint64(meta.LogIndex, "log index")
	if err != nil {
		return EventMetadata{}, err
	}
	return EventMetadata{
		BlockNumber:      blockNumber,
		BlockHash:        meta.BlockHash,
		TransactionHash:  meta.TransactionHash,
		TransactionIndex: transactionIndex,
		LogIndex:         logIndex,
	}, nil
}

func int64FromUint64(value uint64, field string) (int64, error) {
	if value > math.MaxInt64 {
		return 0, fmt.Errorf("%s %d does not fit int64", field, value)
	}
	return int64(value), nil
}

func intFromUint64(value uint64, field string) (int, error) {
	if value > math.MaxInt {
		return 0, fmt.Errorf("%s %d does not fit int", field, value)
	}
	return int(value), nil
}

// failRange records a failed range on the checkpoint and returns the failure.
// The status write is detached from the run context so an expiring run still
// records why it failed. The checkpoint's next block is never touched here: only
// a committed range advances it.
func (j *Job) failRange(ctx context.Context, contractID int64, cause error) error {
	failure := j.wrap(cause)

	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), statusWriteTimeout)
	defer cancel()
	if _, err := j.repo.SetCheckpointStatus(writeCtx, contractID, StatusError, failure.Error()); err != nil {
		j.logger.Error("indexer could not record the failure on the checkpoint",
			"contractId", contractID, "error", j.wrap(err).Error())
	}
	return failure
}

// wrap sanitizes a message before it can reach a log line or a checkpoint.
func (j *Job) wrap(err error) error {
	return SanitizeError(err, j.rpcURL)
}
