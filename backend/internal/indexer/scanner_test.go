package indexer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/evm"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/worker"
)

// The job must satisfy the worker's contract, so a wiring mistake fails at
// compile time instead of at startup.
var _ worker.Job = (*Job)(nil)

const (
	scannerChainID     int64 = 11155111
	scannerRPCURL            = "https://eth-sepolia.g.alchemy.com/v2/scanner-unit-secret"
	scannerTestAddress       = "0x5b324f41e5889cf94cba8e909089683a1a97c318"
	scannerTestOwner         = "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746"
)

// scannerReader is a scriptable ChainReader. Block headers are derived from the
// requested heights unless a test overrides them, so a range assertion reads
// from the recorded request.
type scannerReader struct {
	latestBlock uint64
	latestErr   error

	headers    []evm.BlockHeader
	headersErr error
	headerArgs []uint64
	headerCall int

	// canonicalHash replaces the derived hash per block number, which is how a
	// reassigned chain is scripted for the reorganization tests. It applies to
	// every header request, including the walk, so the reader stays consistent
	// within a phase.
	canonicalHash func(number uint64) string

	logs        []evm.RawLog
	logsErr     error
	logFilters  []evm.LogFilter
	filterCalls []string
}

func (r *scannerReader) BlockNumber(context.Context) (uint64, error) {
	return r.latestBlock, r.latestErr
}

func (r *scannerReader) BlockHeaders(_ context.Context, blockNumbers []uint64) ([]evm.BlockHeader, error) {
	r.headerCall++
	r.headerArgs = append([]uint64(nil), blockNumbers...)
	if r.headersErr != nil {
		return nil, r.headersErr
	}
	if r.headers != nil {
		return append([]evm.BlockHeader(nil), r.headers...), nil
	}
	headers := make([]evm.BlockHeader, 0, len(blockNumbers))
	for _, number := range blockNumbers {
		headers = append(headers, r.header(number))
	}
	return headers, nil
}

// header derives the canonical header for one height, through the scripted hash
// when a test set one.
func (r *scannerReader) header(number uint64) evm.BlockHeader {
	hash := scannerTestHash
	if r.canonicalHash != nil {
		hash = r.canonicalHash
	}
	parentHash := "0x" + strings.Repeat("00", 32)
	if number > 0 {
		parentHash = hash(number - 1)
	}
	return evm.BlockHeader{Number: number, Hash: hash(number), ParentHash: parentHash}
}

func (r *scannerReader) FilterLogs(_ context.Context, filter evm.LogFilter) ([]evm.RawLog, error) {
	r.logFilters = append(r.logFilters, filter)
	r.filterCalls = append(r.filterCalls, filter.Address)
	if r.logsErr != nil {
		return nil, r.logsErr
	}
	return append([]evm.RawLog(nil), r.logs...), nil
}

type statusCall struct {
	contractID int64
	status     CheckpointStatus
	lastError  string
}

// scannerRepository is a scriptable Repository. Methods the scanner never calls
// fail loudly, so an unexpected call is visible instead of silent.
type scannerRepository struct {
	targets    []WatchTarget
	targetsErr error

	checkpoints map[int64]*Checkpoint
	ensureErr   error

	statusCalls []statusCall
	statusErr   error

	commits   []RangeCommit
	commitErr error

	ensureCalls int

	// storedBlocks is the canonical history the reorganization walk reads,
	// keyed by contract and held newest first, the order the repository
	// promises. CommitRange extends it, so a later run sees the tip it stored.
	storedBlocks    map[int64][]BlockHeader
	blocksErr       error
	blockWindows    []blockWindow
	rewindAncestors []rewindCall
	rewindStarts    []int64
	ancestorErr     error
	startErr        error
}

// blockWindow records one ListIndexedBlocks read.
type blockWindow struct {
	contractID         int64
	fromBlock, toBlock int64
}

// rewindCall records one RewindToAncestor call.
type rewindCall struct {
	contractID    int64
	ancestorBlock int64
}

func newScannerRepository(targets ...WatchTarget) *scannerRepository {
	return &scannerRepository{
		targets:      targets,
		checkpoints:  map[int64]*Checkpoint{},
		storedBlocks: map[int64][]BlockHeader{},
	}
}

// storeBlocks records canonical history for a contract, newest block first.
func (r *scannerRepository) storeBlocks(contractID int64, headers []BlockHeader) {
	r.storedBlocks[contractID] = append([]BlockHeader(nil), headers...)
	if len(headers) == 0 {
		return
	}
	checkpoint, ok := r.checkpoints[contractID]
	if !ok {
		return
	}
	tip := headers[0].BlockNumber
	hash := headers[0].BlockHash
	checkpoint.LastIndexedBlock = &tip
	checkpoint.LastIndexedBlockHash = &hash
	checkpoint.NextBlock = tip + 1
}

func (r *scannerRepository) ListWatchTargets(context.Context) ([]WatchTarget, error) {
	if r.targetsErr != nil {
		return nil, r.targetsErr
	}
	return append([]WatchTarget(nil), r.targets...), nil
}

func (r *scannerRepository) EnsureCheckpoint(_ context.Context, contractID int64) (*Checkpoint, error) {
	r.ensureCalls++
	if r.ensureErr != nil {
		return nil, r.ensureErr
	}
	checkpoint, ok := r.checkpoints[contractID]
	if !ok {
		return nil, ErrContractNotFound
	}
	copied := *checkpoint
	return &copied, nil
}

func (r *scannerRepository) GetCheckpoint(_ context.Context, contractID int64) (*Checkpoint, error) {
	checkpoint, ok := r.checkpoints[contractID]
	if !ok {
		return nil, ErrCheckpointNotFound
	}
	copied := *checkpoint
	return &copied, nil
}

func (r *scannerRepository) SetCheckpointStatus(_ context.Context, contractID int64, status CheckpointStatus, lastError string) (*Checkpoint, error) {
	if r.statusErr != nil {
		return nil, r.statusErr
	}
	r.statusCalls = append(r.statusCalls, statusCall{contractID: contractID, status: status, lastError: lastError})
	checkpoint, ok := r.checkpoints[contractID]
	if !ok {
		return nil, ErrCheckpointNotFound
	}
	checkpoint.Status = status
	if status == StatusError {
		message := lastError
		checkpoint.LastError = &message
	} else {
		checkpoint.LastError = nil
	}
	return checkpoint, nil
}

func (r *scannerRepository) ResetRunningCheckpoints(context.Context) (int64, error) {
	return 0, nil
}

// ListContractEvents is unused by the scanner. It exists because the scanner
// takes the whole repository port, which now carries the API's read as well.
func (r *scannerRepository) ListContractEvents(context.Context, int64, EventPage) ([]Event, int, error) {
	return nil, 0, errors.New("list contract events is not used by the scanner")
}

func (r *scannerRepository) CommitRange(_ context.Context, commit RangeCommit) (*Checkpoint, error) {
	if r.commitErr != nil {
		return nil, r.commitErr
	}
	r.commits = append(r.commits, commit)

	checkpoint, ok := r.checkpoints[commit.ContractID]
	if !ok {
		return nil, ErrCheckpointNotFound
	}
	checkpoint.NextBlock = commit.ToBlock + 1
	checkpoint.Status = commit.Status
	checkpoint.LastError = nil
	lastBlock := commit.ToBlock
	checkpoint.LastIndexedBlock = &lastBlock
	lastHash := ""
	for _, header := range commit.Blocks {
		if header.BlockNumber == commit.ToBlock {
			lastHash = header.BlockHash
		}
	}
	checkpoint.LastIndexedBlockHash = &lastHash

	// The stored history mirrors what the range commit wrote, newest first.
	stored := make([]BlockHeader, 0, len(commit.Blocks))
	for i := len(commit.Blocks) - 1; i >= 0; i-- {
		stored = append(stored, commit.Blocks[i])
	}
	r.storedBlocks[commit.ContractID] = append(stored, r.storedBlocks[commit.ContractID]...)
	return checkpoint, nil
}

// ListIndexedBlocks returns stored rows for the window, newest first, mirroring
// the repository contract including the empty-window case.
func (r *scannerRepository) ListIndexedBlocks(_ context.Context, contractID int64, fromBlock, toBlock int64) ([]BlockHeader, error) {
	r.blockWindows = append(r.blockWindows, blockWindow{contractID: contractID, fromBlock: fromBlock, toBlock: toBlock})
	if r.blocksErr != nil {
		return nil, r.blocksErr
	}

	var window []BlockHeader
	for _, header := range r.storedBlocks[contractID] {
		if header.BlockNumber >= fromBlock && header.BlockNumber <= toBlock {
			window = append(window, header)
		}
	}
	return window, nil
}

func (r *scannerRepository) RewindToAncestor(_ context.Context, contractID int64, ancestorBlock int64) (*Checkpoint, error) {
	r.rewindAncestors = append(r.rewindAncestors, rewindCall{contractID: contractID, ancestorBlock: ancestorBlock})
	if r.ancestorErr != nil {
		return nil, r.ancestorErr
	}

	checkpoint, ok := r.checkpoints[contractID]
	if !ok {
		return nil, ErrCheckpointNotFound
	}
	var ancestorHash string
	var kept []BlockHeader
	for _, header := range r.storedBlocks[contractID] {
		if header.BlockNumber > ancestorBlock {
			continue
		}
		if header.BlockNumber == ancestorBlock {
			ancestorHash = header.BlockHash
		}
		kept = append(kept, header)
	}
	if ancestorHash == "" {
		return nil, ErrAncestorNotFound
	}

	r.storedBlocks[contractID] = kept
	checkpoint.NextBlock = ancestorBlock + 1
	checkpoint.Status = StatusPending
	checkpoint.LastError = nil
	checkpoint.LastIndexedBlock = &ancestorBlock
	checkpoint.LastIndexedBlockHash = &ancestorHash
	return checkpoint, nil
}

func (r *scannerRepository) RewindToStart(_ context.Context, contractID int64) (*Checkpoint, error) {
	r.rewindStarts = append(r.rewindStarts, contractID)
	if r.startErr != nil {
		return nil, r.startErr
	}

	checkpoint, ok := r.checkpoints[contractID]
	if !ok {
		return nil, ErrCheckpointNotFound
	}
	startBlock := int64(0)
	for _, target := range r.targets {
		if target.ContractID == contractID {
			startBlock = target.StartBlock
		}
	}
	r.storedBlocks[contractID] = nil
	checkpoint.NextBlock = startBlock
	checkpoint.Status = StatusPending
	checkpoint.LastError = nil
	checkpoint.LastIndexedBlock = nil
	checkpoint.LastIndexedBlockHash = nil
	return checkpoint, nil
}

func (r *scannerRepository) RebuildProjections(context.Context, int64) error {
	return errors.New("rebuild is not used by the scanner")
}

// contextGuardedRepository refuses a write whose context is already canceled.
// It proves that the failure status write is detached from a canceled run.
type contextGuardedRepository struct {
	*scannerRepository
}

func (r *contextGuardedRepository) SetCheckpointStatus(ctx context.Context, contractID int64, status CheckpointStatus, lastError string) (*Checkpoint, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("status write refused: %w", err)
	}
	return r.scannerRepository.SetCheckpointStatus(ctx, contractID, status, lastError)
}

func (r *contextGuardedRepository) CommitRange(ctx context.Context, commit RangeCommit) (*Checkpoint, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("commit refused: %w", err)
	}
	return r.scannerRepository.CommitRange(ctx, commit)
}

func scannerTestDeployment(repo *scannerRepository, contractID, startBlock int64, address string, chainID int64, enabled bool) {
	repo.targets = append(repo.targets, WatchTarget{
		ContractID:      contractID,
		ChainID:         chainID,
		Address:         address,
		StartBlock:      startBlock,
		IndexingEnabled: enabled,
	})
	repo.checkpoints[contractID] = &Checkpoint{
		ContractID: contractID,
		NextBlock:  startBlock,
		Status:     StatusPending,
	}
}

func scannerTestHash(number uint64) string {
	return "0x" + fmt.Sprintf("%064x", number+1)
}

func scannerTestHeader(number uint64) evm.BlockHeader {
	parentHash := "0x" + strings.Repeat("00", 32)
	if number > 0 {
		parentHash = scannerTestHash(number - 1)
	}
	return evm.BlockHeader{Number: number, Hash: scannerTestHash(number), ParentHash: parentHash}
}

// scannerTestLog builds a log whose block hash matches the derived header for
// the block. Non-indexed data is empty, which is what ConfirmTransaction,
// RevokeConfirmation and ExecuteTransaction carry.
func scannerTestLog(blockNumber uint64, topics ...string) evm.RawLog {
	return evm.RawLog{
		Address:         scannerTestAddress,
		Topics:          topics,
		BlockNumber:     blockNumber,
		BlockHash:       scannerTestHash(blockNumber),
		TransactionHash: "0x" + fmt.Sprintf("%064x", blockNumber+900),
	}
}

func scannerTestTopic(t *testing.T, name string) string {
	t.Helper()

	names := []string{EventSubmitTransaction, EventConfirmTransaction, EventRevokeConfirmation, EventExecuteTransaction}
	index := -1
	for i, candidate := range names {
		if candidate == name {
			index = i
		}
	}
	if index < 0 {
		t.Fatalf("unknown event name %q", name)
	}
	return evm.SupportedEventTopics()[index]
}

func scannerAddressTopic(address string) string {
	return "0x000000000000000000000000" + strings.TrimPrefix(address, "0x")
}

func scannerIndexTopic(index uint64) string {
	return "0x" + fmt.Sprintf("%064x", index)
}

// scannerOwnerLog builds an owner event log: ConfirmTransaction,
// RevokeConfirmation or ExecuteTransaction.
func scannerOwnerLog(t *testing.T, eventName string, blockNumber uint64, multisigTxIndex uint64, logIndex uint64) evm.RawLog {
	t.Helper()

	log := scannerTestLog(blockNumber,
		scannerTestTopic(t, eventName),
		scannerAddressTopic(scannerTestOwner),
		scannerIndexTopic(multisigTxIndex),
	)
	log.LogIndex = logIndex
	return log
}

// scannerSubmitLog builds a SubmitTransaction log with the ABI-encoded
// non-indexed value and calldata.
func scannerSubmitLog(t *testing.T, blockNumber uint64, to string, valueWei *big.Int, callData []byte, multisigTxIndex uint64, logIndex uint64) evm.RawLog {
	t.Helper()

	log := scannerTestLog(blockNumber,
		scannerTestTopic(t, EventSubmitTransaction),
		scannerAddressTopic(scannerTestOwner),
		scannerIndexTopic(multisigTxIndex),
		scannerAddressTopic(to),
	)
	log.Data = packSubmitData(valueWei, callData)
	log.LogIndex = logIndex
	return log
}

// packSubmitData encodes the non-indexed (uint256, bytes) fields of
// SubmitTransaction in canonical ABI form, without pulling go-ethereum into
// this package.
func packSubmitData(valueWei *big.Int, callData []byte) []byte {
	word := func(value *big.Int) []byte {
		out := make([]byte, 32)
		value.FillBytes(out)
		return out
	}

	padded := make([]byte, (len(callData)+31)/32*32)
	copy(padded, callData)

	out := make([]byte, 0, 96+len(padded))
	out = append(out, word(valueWei)...)                         // value
	out = append(out, word(big.NewInt(64))...)                   // offset of the bytes field
	out = append(out, word(big.NewInt(int64(len(callData))))...) // length
	return append(out, padded...)
}

func newScannerJob(t *testing.T, repo Repository, reader ChainReader, logger *slog.Logger) *Job {
	t.Helper()

	if logger == nil {
		logger = scannerDiscardLogger()
	}
	job, err := NewJob(repo, reader, scannerChainID, scannerRPCURL, logger)
	if err != nil {
		t.Fatalf("NewJob() = %v, want nil", err)
	}
	return job
}

func scannerDiscardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
}

func TestNewJobValidation(t *testing.T) {
	repo := newScannerRepository()
	reader := &scannerReader{}

	cases := map[string]struct {
		repo    Repository
		reader  ChainReader
		chainID int64
		logger  *slog.Logger
	}{
		"nil repository": {reader: reader, chainID: scannerChainID, logger: scannerDiscardLogger()},
		"nil reader":     {repo: repo, chainID: scannerChainID, logger: scannerDiscardLogger()},
		"zero chain":     {repo: repo, reader: reader, logger: scannerDiscardLogger()},
		"negative chain": {repo: repo, reader: reader, chainID: -1, logger: scannerDiscardLogger()},
		"nil logger":     {repo: repo, reader: reader, chainID: scannerChainID},
	}
	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewJob(tt.repo, tt.reader, tt.chainID, "", tt.logger); err == nil {
				t.Fatal("NewJob() = nil, want an error")
			}
		})
	}
}

func TestJobSafeHead(t *testing.T) {
	cases := map[string]struct {
		latest     uint64
		wantCommit bool
		wantFrom   int64
		wantTo     int64
	}{
		"below the confirmation window": {latest: 10, wantCommit: false},
		"exactly at the window":         {latest: 11, wantCommit: true, wantFrom: 0, wantTo: 0},
		"one block later":               {latest: 12, wantCommit: true, wantFrom: 0, wantTo: 1},
	}
	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			repo := newScannerRepository()
			scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
			reader := &scannerReader{latestBlock: tt.latest}
			job := newScannerJob(t, repo, reader, nil)

			if err := job.Run(t.Context()); err != nil {
				t.Fatalf("Run() = %v, want nil", err)
			}
			if !tt.wantCommit {
				if len(repo.commits) != 0 || len(reader.filterCalls) != 0 || reader.headerCall != 0 {
					t.Fatalf("a chain younger than the window produced work: %d commits, %d log reads, %d header batches",
						len(repo.commits), len(reader.filterCalls), reader.headerCall)
				}
				return
			}
			if len(repo.commits) != 1 {
				t.Fatalf("commits = %d, want 1", len(repo.commits))
			}
			if repo.commits[0].FromBlock != tt.wantFrom || repo.commits[0].ToBlock != tt.wantTo {
				t.Errorf("range = %d..%d, want %d..%d", repo.commits[0].FromBlock, repo.commits[0].ToBlock, tt.wantFrom, tt.wantTo)
			}
			if repo.commits[0].Status != StatusIdle {
				t.Errorf("status = %q, want idle at the safe head", repo.commits[0].Status)
			}
		})
	}
}

func TestJobSafeHeadBelowNextBlock(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 1000, scannerTestAddress, scannerChainID, true)
	repo.checkpoints[1].Status = StatusIdle

	reader := &scannerReader{latestBlock: 100}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if reader.headerCall != 0 || len(reader.filterCalls) != 0 {
		t.Errorf("a caught-up contract was read: %d header batches, %d log reads", reader.headerCall, len(reader.filterCalls))
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %d, want 0", len(repo.commits))
	}
	if len(repo.statusCalls) != 0 {
		t.Errorf("status writes = %v, want none for an already idle checkpoint", repo.statusCalls)
	}
}

func TestJobRangeBounds(t *testing.T) {
	cases := map[string]struct {
		nextBlock  int64
		latest     uint64
		wantFrom   int64
		wantTo     int64
		wantStatus CheckpointStatus
		wantBlocks int
	}{
		"full range of one hundred blocks": {
			nextBlock: 100, latest: 500,
			wantFrom: 100, wantTo: 199, wantStatus: StatusPending, wantBlocks: 100,
		},
		"partial tail up to the safe head": {
			nextBlock: 195, latest: 261,
			wantFrom: 195, wantTo: 250, wantStatus: StatusIdle, wantBlocks: 56,
		},
		"single block at the safe head": {
			nextBlock: 249, latest: 260,
			wantFrom: 249, wantTo: 249, wantStatus: StatusIdle, wantBlocks: 1,
		},
	}
	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			repo := newScannerRepository()
			scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
			repo.checkpoints[1].NextBlock = tt.nextBlock

			reader := &scannerReader{latestBlock: tt.latest}
			job := newScannerJob(t, repo, reader, nil)
			if err := job.Run(t.Context()); err != nil {
				t.Fatalf("Run() = %v, want nil", err)
			}
			if len(repo.commits) != 1 {
				t.Fatalf("commits = %d, want 1", len(repo.commits))
			}

			commit := repo.commits[0]
			if commit.FromBlock != tt.wantFrom || commit.ToBlock != tt.wantTo {
				t.Errorf("range = %d..%d, want %d..%d", commit.FromBlock, commit.ToBlock, tt.wantFrom, tt.wantTo)
			}
			if commit.Status != tt.wantStatus {
				t.Errorf("status = %q, want %q", commit.Status, tt.wantStatus)
			}
			if len(commit.Blocks) != tt.wantBlocks {
				t.Errorf("committed headers = %d, want %d", len(commit.Blocks), tt.wantBlocks)
			}
			if len(reader.headerArgs) != tt.wantBlocks {
				t.Fatalf("batch requested %d headers, want %d", len(reader.headerArgs), tt.wantBlocks)
			}
			if reader.headerArgs[0] != uint64(tt.wantFrom) || reader.headerArgs[len(reader.headerArgs)-1] != uint64(tt.wantTo) {
				t.Errorf("batch range = %d..%d, want %d..%d",
					reader.headerArgs[0], reader.headerArgs[len(reader.headerArgs)-1], tt.wantFrom, tt.wantTo)
			}
			if len(reader.logFilters) != 1 {
				t.Fatalf("log reads = %d, want 1", len(reader.logFilters))
			}
			filter := reader.logFilters[0]
			if filter.FromBlock != uint64(tt.wantFrom) || filter.ToBlock != uint64(tt.wantTo) {
				t.Errorf("filter range = %d..%d, want %d..%d", filter.FromBlock, filter.ToBlock, tt.wantFrom, tt.wantTo)
			}
			if filter.Address != scannerTestAddress {
				t.Errorf("filter address = %q, want the deployment address", filter.Address)
			}
			// The filter is always the full four-topic set, so a scan cannot
			// narrow its own coverage.
			if len(filter.Topics) != 1 || len(filter.Topics[0]) != 4 {
				t.Errorf("filter topics = %v, want all four supported topics", filter.Topics)
			}
		})
	}
}

func TestJobUsesStoredStartBlock(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 1234, scannerTestAddress, scannerChainID, true)

	reader := &scannerReader{latestBlock: 2000}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.commits) != 1 {
		t.Fatalf("commits = %d, want 1", len(repo.commits))
	}
	if repo.commits[0].FromBlock != 1234 {
		t.Errorf("first scanned block = %d, want the stored start block 1234", repo.commits[0].FromBlock)
	}
	if len(reader.headerArgs) == 0 || reader.headerArgs[0] != 1234 {
		t.Errorf("first requested header = %v, want 1234", reader.headerArgs)
	}
}

func TestJobRotationSkipsDisabledAndOtherChains(t *testing.T) {
	disabledAddress := "0x00000000000000000000000000000000000000d1"
	otherChainAddress := "0x00000000000000000000000000000000000000c1"
	secondAddress := "0x00000000000000000000000000000000000000b1"

	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	scannerTestDeployment(repo, 2, 0, secondAddress, scannerChainID, true)
	scannerTestDeployment(repo, 3, 0, disabledAddress, scannerChainID, false)
	scannerTestDeployment(repo, 4, 0, otherChainAddress, 1, true)

	reader := &scannerReader{latestBlock: 200}
	job := newScannerJob(t, repo, reader, nil)

	// Four runs rotate over the two eligible contracts: 1, 2, 1, 2.
	for run := 0; run < 4; run++ {
		if err := job.Run(t.Context()); err != nil {
			t.Fatalf("run %d: Run() = %v, want nil", run+1, err)
		}
	}

	wantOrder := []int64{1, 2, 1, 2}
	if len(repo.commits) != len(wantOrder) {
		t.Fatalf("commits = %d, want %d", len(repo.commits), len(wantOrder))
	}
	// Each contract advances one range of its own: no duplicate stream for one
	// deployment, and the second contract is not starved.
	wantRanges := []struct{ from, to int64 }{{0, 99}, {0, 99}, {100, 189}, {100, 189}}
	for i, want := range wantOrder {
		commit := repo.commits[i]
		if commit.ContractID != want {
			t.Errorf("commit %d contract = %d, want %d", i, commit.ContractID, want)
		}
		if commit.FromBlock != wantRanges[i].from || commit.ToBlock != wantRanges[i].to {
			t.Errorf("commit %d range = %d..%d, want %d..%d", i, commit.FromBlock, commit.ToBlock, wantRanges[i].from, wantRanges[i].to)
		}
	}

	if len(reader.filterCalls) != 4 {
		t.Errorf("log reads = %d, want one per eligible run", len(reader.filterCalls))
	}
	for _, address := range reader.filterCalls {
		if address != scannerTestAddress && address != secondAddress {
			t.Errorf("a skipped deployment reached the endpoint: %s", address)
		}
	}
	if repo.checkpoints[3].NextBlock != 0 || repo.checkpoints[4].NextBlock != 0 {
		t.Errorf("skipped deployments advanced: %d and %d", repo.checkpoints[3].NextBlock, repo.checkpoints[4].NextBlock)
	}
	for _, call := range repo.statusCalls {
		if call.contractID == 3 || call.contractID == 4 {
			t.Errorf("status written for a skipped deployment: %+v", call)
		}
	}
}

func TestJobRotationProgressesWhenAnotherContractIsCaughtUp(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	scannerTestDeployment(repo, 2, 0, "0x00000000000000000000000000000000000000b1", scannerChainID, true)
	repo.checkpoints[1].NextBlock = 500
	repo.checkpoints[1].Status = StatusIdle

	reader := &scannerReader{latestBlock: 300}
	job := newScannerJob(t, repo, reader, nil)

	for run := 0; run < 2; run++ {
		if err := job.Run(t.Context()); err != nil {
			t.Fatalf("run %d: Run() = %v, want nil", run+1, err)
		}
	}

	if len(repo.commits) != 2 {
		t.Fatalf("commits = %d, want 2: the caught-up contract must not stall the other", len(repo.commits))
	}
	for i, commit := range repo.commits {
		if commit.ContractID != 2 {
			t.Errorf("commit %d scanned contract %d, want the one with work", i, commit.ContractID)
		}
	}
	if repo.commits[1].FromBlock != 100 {
		t.Errorf("second range started at %d, want 100", repo.commits[1].FromBlock)
	}
}

func TestJobNoEligibleContracts(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, false)
	scannerTestDeployment(repo, 2, 0, "0x00000000000000000000000000000000000000c1", 1, true)

	reader := &scannerReader{latestBlock: 1000}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}
	if len(reader.filterCalls) != 0 || reader.headerCall != 0 {
		t.Errorf("a skipped deployment was read: %d log reads, %d header batches", len(reader.filterCalls), reader.headerCall)
	}
	if len(repo.commits) != 0 || len(repo.statusCalls) != 0 {
		t.Errorf("skipped deployments were written: %d commits, %d status writes", len(repo.commits), len(repo.statusCalls))
	}
}

func TestJobOneRangePerRun(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 100, scannerTestAddress, scannerChainID, true)

	reader := &scannerReader{latestBlock: 100000}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.commits) != 1 {
		t.Fatalf("commits = %d, want 1 even though the contract is far behind", len(repo.commits))
	}
	if reader.headerCall != 1 || len(reader.logFilters) != 1 {
		t.Errorf("reads = %d header batches and %d log reads, want one of each", reader.headerCall, len(reader.logFilters))
	}
	if repo.commits[0].ToBlock != 199 {
		t.Errorf("range end = %d, want the 100 block cap", repo.commits[0].ToBlock)
	}
	if repo.commits[0].Status != StatusPending {
		t.Errorf("status = %q, want pending while ranges remain", repo.commits[0].Status)
	}
}

func TestJobCanonicalOrder(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 500, scannerTestAddress, scannerChainID, true)

	reader := &scannerReader{latestBlock: 600}
	// Deliberately unordered: block 501 log 5, then block 500 log 9 and log 2.
	reader.logs = []evm.RawLog{
		scannerOwnerLog(t, EventConfirmTransaction, 501, 1, 5),
		scannerOwnerLog(t, EventConfirmTransaction, 500, 1, 9),
		scannerOwnerLog(t, EventConfirmTransaction, 500, 1, 2),
	}

	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}
	if len(repo.commits) != 1 {
		t.Fatalf("commits = %d, want 1", len(repo.commits))
	}

	events := repo.commits[0].Events
	if len(events) != 3 {
		t.Fatalf("events = %d, want 3", len(events))
	}
	want := [][2]int{{500, 2}, {500, 9}, {501, 5}}
	for i, expected := range want {
		if events[i].BlockNumber != int64(expected[0]) || events[i].LogIndex != expected[1] {
			t.Errorf("event %d = block %d log %d, want block %d log %d",
				i, events[i].BlockNumber, events[i].LogIndex, expected[0], expected[1])
		}
	}
}

func TestJobTransactionIndexOrderWithinBlock(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 700, scannerTestAddress, scannerChainID, true)

	first := scannerOwnerLog(t, EventConfirmTransaction, 700, 1, 3)
	first.TransactionIndex = 5
	second := scannerOwnerLog(t, EventConfirmTransaction, 700, 1, 1)
	second.TransactionIndex = 1

	reader := &scannerReader{latestBlock: 711, logs: []evm.RawLog{first, second}}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	events := repo.commits[0].Events
	if events[0].TransactionIndex != 1 || events[1].TransactionIndex != 5 {
		t.Errorf("transaction order = %d then %d, want 1 then 5", events[0].TransactionIndex, events[1].TransactionIndex)
	}
}

func TestJobBlockHashMismatchFailsTheRange(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 500, scannerTestAddress, scannerChainID, true)

	bad := scannerOwnerLog(t, EventConfirmTransaction, 500, 1, 0)
	bad.BlockHash = "0x" + strings.Repeat("dd", 32)

	reader := &scannerReader{latestBlock: 600, logs: []evm.RawLog{bad}}
	job := newScannerJob(t, repo, reader, nil)

	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want a hash mismatch error")
	}
	if !strings.Contains(err.Error(), "block hash") {
		t.Errorf("error %q does not mention the block hash", err)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %d, want 0 after a mismatch", len(repo.commits))
	}
	if repo.checkpoints[1].NextBlock != 500 {
		t.Errorf("next block = %d, want it left at 500", repo.checkpoints[1].NextBlock)
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobLogWithoutHeaderFailsTheRange(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 500, scannerTestAddress, scannerChainID, true)

	// Headers cover only block 500, but the log claims block 501, which sits
	// inside the requested filter window.
	reader := &scannerReader{
		latestBlock: 600,
		headers:     []evm.BlockHeader{scannerTestHeader(500)},
		logs:        []evm.RawLog{scannerOwnerLog(t, EventConfirmTransaction, 501, 1, 0)},
	}
	job := newScannerJob(t, repo, reader, nil)

	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want an error for a log without a header")
	}
	if !strings.Contains(err.Error(), "no fetched header") {
		t.Errorf("error %q does not mention the missing header", err)
	}
	if len(repo.commits) != 0 {
		t.Error("a log without a verified header must not be committed")
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobRejectsRemovedLog(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 500, scannerTestAddress, scannerChainID, true)

	removed := scannerOwnerLog(t, EventConfirmTransaction, 500, 1, 0)
	removed.Removed = true

	reader := &scannerReader{latestBlock: 600, logs: []evm.RawLog{removed}}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err == nil {
		t.Fatal("Run() = nil, want an error for a removed log")
	}
	if len(repo.commits) != 0 {
		t.Error("a removed log must not be committed as canonical")
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobUnsupportedTopicFailsTheRange(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 500, scannerTestAddress, scannerChainID, true)

	unsupported := scannerTestLog(500, "0x"+strings.Repeat("33", 32), scannerAddressTopic(scannerTestOwner))
	unsupported.LogIndex = 0

	reader := &scannerReader{latestBlock: 600, logs: []evm.RawLog{unsupported}}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err == nil {
		t.Fatal("Run() = nil, want a decode error")
	}
	if len(repo.commits) != 0 {
		t.Error("an undecodable log must not be committed")
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobEventMapping(t *testing.T) {
	const (
		to          = "0x000000000000000000000000000000000000dead"
		callData    = "0x010203"
		valueWei    = "1000000000000000000"
		blockNumber = 700
	)

	value, ok := new(big.Int).SetString(valueWei, 10)
	if !ok {
		t.Fatalf("parse value %q", valueWei)
	}
	calldata, err := ParseHexBytes(callData)
	if err != nil {
		t.Fatalf("parse calldata: %v", err)
	}

	// The endpoint returns the four events in a scrambled order; each one
	// carries the position of the transaction that emitted it.
	submit := scannerSubmitLog(t, blockNumber, to, value, calldata, 7, 0)
	submit.TransactionIndex = 1
	confirm := scannerOwnerLog(t, EventConfirmTransaction, blockNumber, 7, 3)
	confirm.TransactionIndex = 3
	revoke := scannerOwnerLog(t, EventRevokeConfirmation, blockNumber, 7, 1)
	revoke.TransactionIndex = 2
	execute := scannerOwnerLog(t, EventExecuteTransaction, blockNumber, 7, 0)
	execute.TransactionIndex = 4

	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, blockNumber, scannerTestAddress, scannerChainID, true)
	reader := &scannerReader{latestBlock: blockNumber + 11, logs: []evm.RawLog{execute, confirm, submit, revoke}}
	job := newScannerJob(t, repo, reader, nil)

	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}
	if len(repo.commits) != 1 {
		t.Fatalf("commits = %d, want 1", len(repo.commits))
	}
	if repo.commits[0].Status != StatusIdle {
		t.Errorf("status = %q, want idle at the safe head", repo.commits[0].Status)
	}

	events := repo.commits[0].Events
	// The stored order follows the transactions, not the order the endpoint
	// happened to return.
	wantOrder := []struct {
		name             string
		transactionIndex int
	}{
		{EventSubmitTransaction, 1},
		{EventRevokeConfirmation, 2},
		{EventConfirmTransaction, 3},
		{EventExecuteTransaction, 4},
	}

	for i, expected := range wantOrder {
		event := events[i]
		if event.EventName != expected.name {
			t.Errorf("event %d = %q, want %q", i, event.EventName, expected.name)
		}
		if event.ContractID != 1 {
			t.Errorf("event %d contract = %d, want 1", i, event.ContractID)
		}
		if event.ActorAddress != scannerTestOwner {
			t.Errorf("event %d actor = %q, want the indexed owner", i, event.ActorAddress)
		}
		if event.MultisigTxIndex != "7" {
			t.Errorf("event %d multisig index = %q, want 7", i, event.MultisigTxIndex)
		}
		if event.BlockNumber != blockNumber || event.TransactionIndex != expected.transactionIndex {
			t.Errorf("event %d position = block %d transaction %d, want block %d transaction %d",
				i, event.BlockNumber, event.TransactionIndex, blockNumber, expected.transactionIndex)
		}
		if event.BlockHash != scannerTestHash(blockNumber) {
			t.Errorf("event %d block hash = %q, want the verified header hash", i, event.BlockHash)
		}
	}

	payload, err := DecodeSubmitPayload(events[0].Payload)
	if err != nil {
		t.Fatalf("decode submit payload: %v", err)
	}
	if payload.To != to {
		t.Errorf("payload destination = %q, want %q", payload.To, to)
	}
	if payload.ValueWei != valueWei {
		t.Errorf("payload value = %q, want %q", payload.ValueWei, valueWei)
	}
	if payload.Data != callData {
		t.Errorf("payload data = %q, want %q", payload.Data, callData)
	}
}

func TestJobCheckpointTransitions(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	reader := &scannerReader{latestBlock: 1000}
	job := newScannerJob(t, repo, reader, nil)

	// A range that stops short of the safe head is running and stays pending,
	// so the next tick continues with it.
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}
	assertStatusSequence(t, repo, []statusCall{{contractID: 1, status: StatusRunning}})
	if len(repo.commits) != 1 || repo.commits[0].Status != StatusPending {
		t.Fatalf("commits = %+v, want one pending commit", repo.commits)
	}

	// The final range reaches the safe head and the commit marks it idle.
	repo.checkpoints[1].NextBlock = 989
	repo.statusCalls = nil
	repo.commits = nil
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("second Run() = %v, want nil", err)
	}
	assertStatusSequence(t, repo, []statusCall{{contractID: 1, status: StatusRunning}})
	if len(repo.commits) != 1 || repo.commits[0].Status != StatusIdle {
		t.Fatalf("commits = %+v, want one idle commit", repo.commits)
	}
	if repo.commits[0].FromBlock != 989 || repo.commits[0].ToBlock != 989 {
		t.Errorf("range = %d..%d, want the single block 989", repo.commits[0].FromBlock, repo.commits[0].ToBlock)
	}

	// An idle checkpoint behind the safe head is refreshed with no work.
	repo.checkpoints[1].NextBlock = 1000
	repo.statusCalls = nil
	repo.commits = nil
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("third Run() = %v, want nil", err)
	}
	if len(repo.statusCalls) != 0 || len(repo.commits) != 0 {
		t.Errorf("an idle caught-up checkpoint was written again: %v, %+v", repo.statusCalls, repo.commits)
	}

	// A pending checkpoint behind the safe head is left behind by a failed run,
	// so the next tick repairs it to idle without scanning.
	repo.checkpoints[1].Status = StatusPending
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("fourth Run() = %v, want nil", err)
	}
	assertStatusSequence(t, repo, []statusCall{{contractID: 1, status: StatusIdle}})
	if len(repo.commits) != 0 {
		t.Errorf("commits = %+v, want none while the checkpoint is behind the safe head", repo.commits)
	}
}

func TestJobFailureKeepsCheckpointAndClearsOnSuccess(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	reader := &scannerReader{latestBlock: 1000, headersErr: errors.New("rpc unavailable")}
	job := newScannerJob(t, repo, reader, nil)

	if err := job.Run(t.Context()); err == nil {
		t.Fatal("Run() = nil, want the read failure")
	}
	if repo.checkpoints[1].NextBlock != 0 {
		t.Errorf("next block = %d, want it left at 0", repo.checkpoints[1].NextBlock)
	}
	failure := assertLastStatus(t, repo, StatusError)
	if failure.lastError == "" {
		t.Error("error status must carry a message")
	}

	// The next tick retries the same range and clears the error.
	repo.statusCalls = nil
	reader.headersErr = nil
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("retry Run() = %v, want nil", err)
	}
	if len(repo.commits) != 1 || repo.commits[0].FromBlock != 0 {
		t.Fatalf("retry committed %+v, want the unchanged range from block 0", repo.commits)
	}
	if repo.checkpoints[1].LastError != nil {
		t.Errorf("last error = %q, want it cleared", *repo.checkpoints[1].LastError)
	}
}

func TestJobCommitFailureLeavesCheckpoint(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	repo.commitErr = errors.New("database is not available")

	reader := &scannerReader{latestBlock: 1000}
	job := newScannerJob(t, repo, reader, nil)

	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want the commit failure")
	}
	if !errors.Is(err, repo.commitErr) {
		t.Errorf("error %v does not wrap the commit failure", err)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %d, want 0", len(repo.commits))
	}
	if repo.checkpoints[1].NextBlock != 0 {
		t.Errorf("next block = %d, want 0", repo.checkpoints[1].NextBlock)
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobWatchSetFailureSetsNoStatus(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	repo.targetsErr = errors.New("database is not available")

	reader := &scannerReader{latestBlock: 1000}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err == nil {
		t.Fatal("Run() = nil, want the watch set failure")
	}
	if len(repo.statusCalls) != 0 {
		t.Errorf("status writes = %v, want none: no contract owns this failure", repo.statusCalls)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %d, want 0", len(repo.commits))
	}
}

// cancelOnReadReader cancels the run context when the log read starts, which is
// how a shutdown or an expiring run lands in the middle of a range.
type cancelOnReadReader struct {
	*scannerReader
	cancel context.CancelFunc
}

func (r *cancelOnReadReader) FilterLogs(ctx context.Context, filter evm.LogFilter) ([]evm.RawLog, error) {
	if r.cancel != nil {
		r.cancel()
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestJobCanceledContextMakesNoChanges(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	reader := &scannerReader{latestBlock: 1000, latestErr: context.Canceled}
	job := newScannerJob(t, repo, reader, nil)

	canceled, cancel := context.WithCancel(t.Context())
	cancel()

	if err := job.Run(canceled); err == nil {
		t.Fatal("Run() = nil, want the cancellation error")
	}
	if len(repo.commits) != 0 || len(repo.statusCalls) != 0 {
		t.Errorf("a canceled run wrote to the repository: %d commits, %v", len(repo.commits), repo.statusCalls)
	}
	if repo.ensureCalls != 0 {
		t.Errorf("checkpoint reads = %d, want 0", repo.ensureCalls)
	}

	// A run canceled mid range records the failure but never advances the
	// checkpoint, and the next run resumes from the same block.
	base := &scannerReader{latestBlock: 1000}
	ctx, cancelRange := context.WithCancel(t.Context())
	guarded := &contextGuardedRepository{scannerRepository: repo}
	job = newScannerJob(t, guarded, &cancelOnReadReader{scannerReader: base, cancel: cancelRange}, nil)

	if err := job.Run(ctx); err == nil {
		t.Fatal("Run() = nil, want the canceled range error")
	}
	if len(repo.commits) != 0 {
		t.Fatalf("commits = %d, want 0 for a canceled range", len(repo.commits))
	}
	if repo.checkpoints[1].NextBlock != 0 {
		t.Errorf("next block = %d, want it unchanged", repo.checkpoints[1].NextBlock)
	}
	failure := assertLastStatus(t, repo, StatusError)
	if !strings.Contains(failure.lastError, "canceled") {
		t.Errorf("last error = %q, want the cancellation reason", failure.lastError)
	}

	// Resuming with a live context commits the range the canceled run left
	// behind, proving nothing was lost by the stop.
	repo.statusCalls = nil
	resumed := newScannerJob(t, repo, base, nil)
	if err := resumed.Run(t.Context()); err != nil {
		t.Fatalf("resume Run() = %v, want nil", err)
	}
	if len(repo.commits) != 1 || repo.commits[0].FromBlock != 0 || repo.commits[0].ToBlock != 99 {
		t.Fatalf("resume committed %+v, want the range 0..99", repo.commits)
	}
	if repo.checkpoints[1].LastError != nil {
		t.Errorf("last error = %q, want it cleared by the successful range", *repo.checkpoints[1].LastError)
	}
}

func TestJobSanitizesFailureMessages(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))

	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	reader := &scannerReader{
		latestBlock: 1000,
		headersErr: fmt.Errorf("Post %q: dial tcp: connection refused; retry https://provider.example/v2/another-key",
			scannerRPCURL),
	}

	job, err := NewJob(repo, reader, scannerChainID, scannerRPCURL, logger)
	if err != nil {
		t.Fatalf("NewJob() = %v, want nil", err)
	}
	failure := job.Run(t.Context())
	if failure == nil {
		t.Fatal("Run() = nil, want the read failure")
	}

	// The worker logs whatever the job returns, so the returned message must
	// already be safe.
	logger.Error("worker job failed", "error", failure)
	assertNoScannerSecrets(t, failure.Error())
	assertNoScannerSecrets(t, logs.String())

	call := assertLastStatus(t, repo, StatusError)
	assertNoScannerSecrets(t, call.lastError)
}

func assertNoScannerSecrets(t *testing.T, message string) {
	t.Helper()

	for _, secret := range []string{"scanner-unit-secret", "another-key"} {
		if strings.Contains(message, secret) {
			t.Errorf("message contains %q: %s", secret, message)
		}
	}
}

func TestSanitize(t *testing.T) {
	message := SanitizeMessage("  Post https://eth-sepolia.g.alchemy.com/v2/key-abc123: dial tcp\nrefused  ", "key-abc123")
	if strings.Contains(message, "key-abc123") {
		t.Errorf("secret survived sanitization: %q", message)
	}
	if strings.Contains(message, "\n") {
		t.Errorf("message still spans lines: %q", message)
	}
	if !strings.HasPrefix(message, "Post ") {
		t.Errorf("message = %q, want it trimmed", message)
	}

	// A plain host stays readable: only the keyed provider path is redacted.
	if got := SanitizeMessage("dial https://rpc.example.com:8545 failed"); strings.Contains(got, redactedMarker) {
		t.Errorf("SanitizeMessage() = %q, want the host preserved", got)
	}

	if long := SanitizeMessage(strings.Repeat("x", maxErrorMessage*2)); len(long) > maxErrorMessage+3 {
		t.Errorf("message length = %d, want it bounded", len(long))
	}
	if got := SanitizeError(nil, "secret"); got != nil {
		t.Errorf("SanitizeError(nil) = %v, want nil", got)
	}

	cause := errors.New("cause")
	wrapped := SanitizeError(cause, "secret")
	if !errors.Is(wrapped, cause) {
		t.Error("SanitizedError must preserve the cause for errors.Is")
	}
	var sanitized *SanitizedError
	if !errors.As(wrapped, &sanitized) {
		t.Error("SanitizedError must be discoverable with errors.As")
	}
}

func TestJobCheckpointReadFailureWritesNoStatus(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	repo.ensureErr = ErrContractNotFound

	reader := &scannerReader{latestBlock: 1000}
	job := newScannerJob(t, repo, reader, nil)

	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want the checkpoint failure")
	}
	if !errors.Is(err, ErrContractNotFound) {
		t.Errorf("error %v does not wrap the repository error", err)
	}
	if len(repo.statusCalls) != 0 {
		t.Errorf("status writes = %v, want none when the checkpoint cannot be read", repo.statusCalls)
	}
}

func assertStatusSequence(t *testing.T, repo *scannerRepository, want []statusCall) {
	t.Helper()

	if len(repo.statusCalls) != len(want) {
		t.Fatalf("status writes = %v, want %v", repo.statusCalls, want)
	}
	for i, expected := range want {
		got := repo.statusCalls[i]
		if got.contractID != expected.contractID || got.status != expected.status {
			t.Errorf("status write %d = %+v, want %+v", i, got, expected)
		}
	}
}

func assertLastStatus(t *testing.T, repo *scannerRepository, want CheckpointStatus) statusCall {
	t.Helper()

	if len(repo.statusCalls) == 0 {
		t.Fatalf("no status writes, want the last one to be %q", want)
	}
	last := repo.statusCalls[len(repo.statusCalls)-1]
	if last.status != want {
		t.Fatalf("last status = %q, want %q", last.status, want)
	}
	return last
}
