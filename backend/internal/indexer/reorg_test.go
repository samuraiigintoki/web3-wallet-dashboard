package indexer

import (
	"errors"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/evm"
)

// storedChain builds the stored canonical history for a contract from a list of
// ascending block heights, using the reader's derived hashes, and points the
// checkpoint at the newest one.
func storedChain(repo *scannerRepository, reader *scannerReader, contractID int64, fromBlock, toBlock int64) {
	headers := make([]BlockHeader, 0, toBlock-fromBlock+1)
	for number := toBlock; number >= fromBlock; number-- {
		headers = append(headers, BlockHeader{
			BlockNumber: number,
			BlockHash:   reader.header(uint64(number)).Hash,
			ParentHash:  reader.header(uint64(number)).ParentHash,
		})
	}
	repo.storeBlocks(contractID, headers)
}

func TestJobMatchingStoredTipScansWithoutRewind(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	reader := &scannerReader{latestBlock: 200}
	storedChain(repo, reader, 1, 0, 99)

	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.rewindAncestors) != 0 || len(repo.rewindStarts) != 0 {
		t.Errorf("a matching stored tip was rewound: %+v %v", repo.rewindAncestors, repo.rewindStarts)
	}
	if len(repo.commits) != 1 {
		t.Fatalf("commits = %d, want the next range", len(repo.commits))
	}
	if repo.commits[0].FromBlock != 100 || repo.commits[0].ToBlock != 189 {
		t.Errorf("range = %d..%d, want 100..189", repo.commits[0].FromBlock, repo.commits[0].ToBlock)
	}
	// One canonical read for the stored tip and one batch for the range.
	if reader.headerCall != 2 {
		t.Errorf("header batches = %d, want the tip check and the range", reader.headerCall)
	}
	if len(repo.blockWindows) != 0 {
		t.Errorf("block windows = %+v, want no walk for a matching tip", repo.blockWindows)
	}
}

func TestJobShallowReorgRewindsToTheForkParent(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 900, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1060}
	storedChain(repo, original, 1, 900, 1000)

	// The chain kept the same history up to block 999 and replaced 1000.
	reassigned := &scannerReader{latestBlock: 1060}
	reassigned.canonicalHash = func(number uint64) string {
		if number >= 1000 {
			return scannerTestHash(number + 5000)
		}
		return scannerTestHash(number)
	}

	job := newScannerJob(t, repo, reassigned, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.rewindAncestors) != 1 {
		t.Fatalf("rewinds = %+v, want exactly one", repo.rewindAncestors)
	}
	if repo.rewindAncestors[0] != (rewindCall{contractID: 1, ancestorBlock: 999}) {
		t.Errorf("rewind = %+v, want the last still-matching block 999", repo.rewindAncestors[0])
	}
	if len(repo.rewindStarts) != 0 {
		t.Errorf("full rewinds = %v, want none", repo.rewindStarts)
	}
	// Scanning resumes at the ancestor, not at the checkpoint the stale tip had
	// advanced to.
	if len(repo.commits) != 1 {
		t.Fatalf("commits = %d, want the corrected range", len(repo.commits))
	}
	if repo.commits[0].FromBlock != 1000 || repo.commits[0].ToBlock != 1049 {
		t.Errorf("range = %d..%d, want 1000..1049", repo.commits[0].FromBlock, repo.commits[0].ToBlock)
	}
	// The stored tip was read once, then one window covered the walk.
	if len(repo.blockWindows) != 1 {
		t.Fatalf("block windows = %+v, want one", repo.blockWindows)
	}
	if repo.blockWindows[0] != (blockWindow{contractID: 1, fromBlock: 901, toBlock: 1000}) {
		t.Errorf("window = %+v, want 901..1000", repo.blockWindows[0])
	}
}

func TestJobDeepReorgWalksStoredWindows(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 700, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1010}
	storedChain(repo, original, 1, 800, 1000)

	// The fork is at block 849, so two windows are walked: 901..1000 and
	// 801..900.
	reassigned := &scannerReader{latestBlock: 1010}
	reassigned.canonicalHash = func(number uint64) string {
		if number >= 850 {
			return scannerTestHash(number + 7000)
		}
		return scannerTestHash(number)
	}

	job := newScannerJob(t, repo, reassigned, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.rewindAncestors) != 1 || repo.rewindAncestors[0].ancestorBlock != 849 {
		t.Fatalf("rewinds = %+v, want one rewind to 849", repo.rewindAncestors)
	}
	wantWindows := []blockWindow{
		{contractID: 1, fromBlock: 901, toBlock: 1000},
		{contractID: 1, fromBlock: 801, toBlock: 900},
	}
	if len(repo.blockWindows) != len(wantWindows) {
		t.Fatalf("block windows = %+v, want %+v", repo.blockWindows, wantWindows)
	}
	for i, want := range wantWindows {
		if repo.blockWindows[i] != want {
			t.Errorf("window %d = %+v, want %+v", i, repo.blockWindows[i], want)
		}
	}
	if len(repo.commits) != 1 || repo.commits[0].FromBlock != 850 {
		t.Fatalf("commits = %+v, want a rescan from 850", repo.commits)
	}
}

func TestJobNoStoredAncestorRewindsToTheStartBlock(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 700, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1010}
	storedChain(repo, original, 1, 800, 900)

	// Every stored row belongs to a chain the endpoint no longer serves.
	reassigned := &scannerReader{
		latestBlock:   1010,
		canonicalHash: func(number uint64) string { return scannerTestHash(number + 9000) },
	}

	job := newScannerJob(t, repo, reassigned, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.rewindStarts) != 1 || repo.rewindStarts[0] != 1 {
		t.Fatalf("full rewinds = %v, want one for contract 1", repo.rewindStarts)
	}
	// No sentinel reaches the repository: the walk reports "no ancestor" and the
	// caller uses the stored start block instead of a negative block number.
	if len(repo.rewindAncestors) != 0 {
		t.Errorf("ancestor rewinds = %+v, want none", repo.rewindAncestors)
	}
	// The same tick rescans from the start block, which is where the rewound
	// checkpoint left it: the stored tip and its hash no longer point at a chain
	// the endpoint serves.
	if len(repo.commits) != 1 {
		t.Fatalf("commits = %+v, want the rescan from the start block", repo.commits)
	}
	if repo.commits[0].FromBlock != 700 || repo.commits[0].ToBlock != 799 {
		t.Errorf("range = %d..%d, want 700..799", repo.commits[0].FromBlock, repo.commits[0].ToBlock)
	}
	if repo.checkpoints[1].NextBlock != 800 {
		t.Errorf("next block = %d, want it advanced from the start block by the rescan", repo.checkpoints[1].NextBlock)
	}
	if repo.checkpoints[1].LastIndexedBlock == nil || *repo.checkpoints[1].LastIndexedBlock != 799 {
		t.Errorf("last indexed block = %v, want the rescanned tip 799", repo.checkpoints[1].LastIndexedBlock)
	}
}

func TestJobWalkStopsAtTheEndOfStoredHistory(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 700, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1010}
	// Rows exist above the checkpoint start block only, so the walk runs out of
	// stored history instead of walking down to block 0.
	storedChain(repo, original, 1, 995, 1000)

	reassigned := &scannerReader{
		latestBlock:   1010,
		canonicalHash: func(number uint64) string { return scannerTestHash(number + 9000) },
	}

	job := newScannerJob(t, repo, reassigned, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.rewindStarts) != 1 {
		t.Fatalf("full rewinds = %v, want one", repo.rewindStarts)
	}
	if len(repo.blockWindows) != 2 {
		t.Fatalf("block windows = %+v, want the two windows that cover the stored rows", repo.blockWindows)
	}
	if last := repo.blockWindows[1]; last.fromBlock != 895 || last.toBlock != 994 {
		t.Errorf("second window = %+v, want 895..994 below the stored rows", last)
	}
}

func TestJobRewindAheadOfTheSafeHeadWritesNoRange(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 900, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1030}
	storedChain(repo, original, 1, 900, 1000)

	// The chain retracted by one block: only the stored tip is no longer
	// canonical, and the safe head now sits below it.
	reassigned := &scannerReader{latestBlock: 1010}
	reassigned.canonicalHash = func(number uint64) string {
		if number >= 1000 {
			return scannerTestHash(number + 6000)
		}
		return scannerTestHash(number)
	}

	job := newScannerJob(t, repo, reassigned, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.rewindAncestors) != 1 || repo.rewindAncestors[0].ancestorBlock != 999 {
		t.Fatalf("rewinds = %+v, want one rewind to 999", repo.rewindAncestors)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %+v, want none while the corrected checkpoint is at the safe head", repo.commits)
	}
	if len(reassigned.filterCalls) != 0 {
		t.Errorf("log reads = %v, want none", reassigned.filterCalls)
	}
	// The corrected checkpoint is behind the safe head and pending, so it is
	// recorded as idle rather than left looking busy.
	assertStatusSequence(t, repo, []statusCall{{contractID: 1, status: StatusIdle}})
}

func TestJobCanonicalReadFailureFailsTheRange(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 900, scannerTestAddress, scannerChainID, true)

	healthy := &scannerReader{latestBlock: 1010}
	storedChain(repo, healthy, 1, 900, 1000)

	reader := &scannerReader{latestBlock: 1010, headersErr: errors.New("rpc unavailable")}
	job := newScannerJob(t, repo, reader, nil)

	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want the canonical read failure")
	}
	if reader.headerCall != 1 {
		t.Errorf("header batches = %d, want a single attempt: only the range operation is retried", reader.headerCall)
	}
	if len(repo.rewindAncestors) != 0 || len(repo.rewindStarts) != 0 {
		t.Errorf("a failed canonical read rewound state: %+v %v", repo.rewindAncestors, repo.rewindStarts)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %+v, want none", repo.commits)
	}
	if repo.checkpoints[1].NextBlock != 1001 {
		t.Errorf("next block = %d, want it untouched", repo.checkpoints[1].NextBlock)
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobWalkReadFailureFailsTheRange(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 900, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1010}
	storedChain(repo, original, 1, 900, 1000)

	reassigned := &scannerReader{
		latestBlock:   1010,
		canonicalHash: func(number uint64) string { return scannerTestHash(number + 4000) },
	}
	repo.blocksErr = errors.New("database is not available")

	job := newScannerJob(t, repo, reassigned, nil)
	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want the stored read failure")
	}
	if !errors.Is(err, repo.blocksErr) {
		t.Errorf("error %v does not wrap the stored read failure", err)
	}
	if len(repo.rewindAncestors) != 0 || len(repo.rewindStarts) != 0 {
		t.Errorf("a failed walk rewound state: %+v %v", repo.rewindAncestors, repo.rewindStarts)
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobRewindFailureFailsTheRange(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 900, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1010}
	storedChain(repo, original, 1, 900, 1000)

	reassigned := &scannerReader{latestBlock: 1010}
	reassigned.canonicalHash = func(number uint64) string {
		if number >= 1000 {
			return scannerTestHash(number + 3000)
		}
		return scannerTestHash(number)
	}
	repo.ancestorErr = errors.New("database is not available")

	job := newScannerJob(t, repo, reassigned, nil)
	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want the rewind failure")
	}
	if !errors.Is(err, repo.ancestorErr) {
		t.Errorf("error %v does not wrap the rewind failure", err)
	}
	if len(repo.rewindAncestors) != 1 {
		t.Errorf("rewinds = %+v, want the attempted rewind", repo.rewindAncestors)
	}
	if repo.checkpoints[1].NextBlock != 1001 {
		t.Errorf("next block = %d, want it untouched by the failed rewind", repo.checkpoints[1].NextBlock)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %+v, want none", repo.commits)
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobCorrectsTheTipEvenWhenItLooksCaughtUp(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 900, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1030}
	storedChain(repo, original, 1, 900, 1000)

	// The chain retracted below the stored tip, so the checkpoint looks caught
	// up while the state it holds was replaced.
	reader := &scannerReader{latestBlock: 1005}
	reader.canonicalHash = func(number uint64) string {
		if number >= 995 {
			return scannerTestHash(number + 2000)
		}
		return scannerTestHash(number)
	}
	repo.checkpoints[1].Status = StatusIdle

	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.rewindAncestors) != 1 || repo.rewindAncestors[0].ancestorBlock != 994 {
		t.Fatalf("rewinds = %+v, want one rewind to 994", repo.rewindAncestors)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %+v, want none while the corrected checkpoint is at the safe head", repo.commits)
	}
	assertStatusSequence(t, repo, []statusCall{{contractID: 1, status: StatusIdle}})
}

func TestJobNoStoredTipSkipsTheCanonicalCheck(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	reader := &scannerReader{latestBlock: 200}
	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}

	if len(repo.blockWindows) != 0 {
		t.Errorf("block windows = %+v, want none for a contract that has never committed a range", repo.blockWindows)
	}
	// The only header read is the range batch.
	if reader.headerCall != 1 {
		t.Errorf("header batches = %d, want the range read alone", reader.headerCall)
	}
}

func TestJobReorgDetectionNeverUsesRemovedLogs(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 900, scannerTestAddress, scannerChainID, true)

	original := &scannerReader{latestBlock: 1010}
	storedChain(repo, original, 1, 900, 950)

	// The endpoint flags a log inside the scanned range as removed. That flag is
	// metadata: the canonical comparison is what decides a rewind, and matching
	// stored hashes mean there is none.
	reader := &scannerReader{latestBlock: 1010}
	removed := scannerOwnerLog(t, EventConfirmTransaction, 960, 1, 0)
	removed.Removed = true
	removed.BlockHash = reader.header(960).Hash
	reader.logs = []evm.RawLog{removed}

	job := newScannerJob(t, repo, reader, nil)

	// The range fails, because a removed log is never committed as canonical.
	// That failure is not a rewind: the flag does not decide chain state.
	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want the removed-log failure")
	}
	if !strings.Contains(err.Error(), "removed") {
		t.Errorf("error %q does not explain the removed log", err)
	}
	if len(repo.rewindAncestors) != 0 || len(repo.rewindStarts) != 0 {
		t.Errorf("a removed flag triggered a rewind: %+v %v", repo.rewindAncestors, repo.rewindStarts)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %+v, want none for a removed log", repo.commits)
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobReorgDetectionComparesStoredHashCaseInsensitively(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 900, scannerTestAddress, scannerChainID, true)

	reader := &scannerReader{latestBlock: 1010}
	storedChain(repo, reader, 1, 900, 1000)
	// A stored hash that differs only in case is the same block.
	upper := strings.ToUpper(strings.TrimPrefix(reader.header(1000).Hash, "0x"))
	checkpoint := repo.checkpoints[1]
	checkpoint.LastIndexedBlockHash = stringPointer("0x" + upper)

	job := newScannerJob(t, repo, reader, nil)
	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}
	if len(repo.rewindAncestors) != 0 || len(repo.rewindStarts) != 0 {
		t.Errorf("a case-only difference triggered a rewind: %+v %v", repo.rewindAncestors, repo.rewindStarts)
	}
}

func stringPointer(value string) *string { return &value }

func TestJobNegativeStoredTipIsRejected(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	checkpoint := repo.checkpoints[1]
	checkpoint.LastIndexedBlock = int64Pointer(-1)
	checkpoint.LastIndexedBlockHash = stringPointer(scannerTestHash(0))

	reader := &scannerReader{latestBlock: 200}
	job := newScannerJob(t, repo, reader, nil)
	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want a rejection for a stored negative tip")
	}
	if !strings.Contains(err.Error(), "must not be negative") {
		t.Errorf("error %q does not explain the rejection", err)
	}
	if reader.headerCall != 0 {
		t.Errorf("header batches = %d, want no request built from a negative height", reader.headerCall)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %+v, want none", repo.commits)
	}
}

func int64Pointer(value int64) *int64 { return &value }

func TestJobWalkWindowMatchesTheRangeCap(t *testing.T) {
	if reorgWalkWindow != maxRangeBlocks {
		t.Errorf("walk window = %d, want it aligned with the range cap %d", reorgWalkWindow, maxRangeBlocks)
	}
	if reorgWalkWindow != int64(evm.MaxHeaderBatch) {
		t.Errorf("walk window = %d, want it aligned with the header batch cap %d", reorgWalkWindow, evm.MaxHeaderBatch)
	}
}
