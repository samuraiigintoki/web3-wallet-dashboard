package indexer

import (
	"context"
	"fmt"
	"strings"
)

// reorgWalkWindow is how many stored block rows one step of the ancestor walk
// reads. It mirrors the range cap and the header batch cap, so one step is one
// stored read and one batched header read.
const reorgWalkWindow int64 = 100

// correctChainState verifies that the stored last indexed block is still the
// canonical block at its height and rewinds when it is not.
//
// Detection is a canonical-hash comparison against the stored checkpoint: the
// stored hash is compared with the header the endpoint serves for the same
// block number. RawLog.Removed is metadata and is never the signal, because a
// log is only marked removed after a reorg has already been detected.
//
// The confirmation window is not finality, so a mismatch at any depth stored in
// indexed_blocks is corrected. A contract with no stored last indexed block has
// nothing to compare and passes through unchanged.
func (j *Job) correctChainState(ctx context.Context, target WatchTarget, checkpoint *Checkpoint) (*Checkpoint, error) {
	if checkpoint.LastIndexedBlock == nil || checkpoint.LastIndexedBlockHash == nil {
		return checkpoint, nil
	}

	tip := *checkpoint.LastIndexedBlock
	if tip < 0 {
		return nil, ValidationError{Field: "lastIndexedBlock", Message: fmt.Sprintf("must not be negative, got %d", tip)}
	}

	canonicalByNumber, err := j.canonicalHeaders(ctx, []int64{tip})
	if err != nil {
		return nil, fmt.Errorf("read canonical header for stored block %d of contract %d: %w", tip, target.ContractID, err)
	}
	if strings.EqualFold(canonicalByNumber[tip], *checkpoint.LastIndexedBlockHash) {
		return checkpoint, nil
	}

	ancestor, found, err := j.findCommonAncestor(ctx, target.ContractID, tip)
	if err != nil {
		return nil, err
	}
	if !found {
		rewound, err := j.repo.RewindToStart(ctx, target.ContractID)
		if err != nil {
			return nil, fmt.Errorf("rewind contract %d to its stored start block: %w", target.ContractID, err)
		}
		j.logger.Warn("indexer rewound a contract to its stored start block",
			"contractId", target.ContractID, "lastIndexedBlock", tip, "nextBlock", rewound.NextBlock)
		return rewound, nil
	}

	rewound, err := j.repo.RewindToAncestor(ctx, target.ContractID, ancestor)
	if err != nil {
		return nil, fmt.Errorf("rewind contract %d to ancestor %d: %w", target.ContractID, ancestor, err)
	}
	j.logger.Warn("indexer rewound a contract to the common ancestor",
		"contractId", target.ContractID, "lastIndexedBlock", tip, "ancestorBlock", ancestor,
		"depth", tip-ancestor, "nextBlock", rewound.NextBlock)
	return rewound, nil
}

// findCommonAncestor walks stored block rows down from tip in bounded windows
// and returns the highest block whose stored hash still matches the canonical
// header for that height. It reports found=false when no stored row matches,
// which is the caller's signal to rewind to the start block instead of to an
// ancestor. It never invents a block number: the search only ever returns a
// height that is stored in indexed_blocks.
func (j *Job) findCommonAncestor(ctx context.Context, contractID, tip int64) (int64, bool, error) {
	for toBlock := tip; toBlock >= 0; {
		fromBlock := toBlock - reorgWalkWindow + 1
		if fromBlock < 0 {
			fromBlock = 0
		}

		stored, err := j.repo.ListIndexedBlocks(ctx, contractID, fromBlock, toBlock)
		if err != nil {
			return 0, false, fmt.Errorf("read stored blocks %d..%d for contract %d: %w", fromBlock, toBlock, contractID, err)
		}
		if len(stored) == 0 {
			// Stored history ends here, so there is no ancestor to rewind to.
			return 0, false, nil
		}

		numbers := make([]int64, 0, len(stored))
		for _, header := range stored {
			if header.BlockNumber < 0 {
				return 0, false, fmt.Errorf("stored block for contract %d has a negative number %d", contractID, header.BlockNumber)
			}
			numbers = append(numbers, header.BlockNumber)
		}
		canonicalByNumber, err := j.canonicalHeaders(ctx, numbers)
		if err != nil {
			return 0, false, fmt.Errorf("read canonical headers for contract %d blocks %d..%d: %w", contractID, fromBlock, toBlock, err)
		}

		// The walk looks for the highest match in the window, so it does not
		// depend on the order the repository returns rows in.
		ancestor := int64(-1)
		for _, header := range stored {
			hash, ok := canonicalByNumber[header.BlockNumber]
			if !ok {
				return 0, false, fmt.Errorf("stored block %d for contract %d has no canonical header", header.BlockNumber, contractID)
			}
			if strings.EqualFold(hash, header.BlockHash) && header.BlockNumber > ancestor {
				ancestor = header.BlockNumber
			}
		}
		if ancestor >= 0 {
			return ancestor, true, nil
		}

		// Continue below the lowest stored row in this window. A window that
		// returns rows always moves the cursor down, so the walk terminates.
		lowest := numbers[0]
		for _, number := range numbers {
			if number < lowest {
				lowest = number
			}
		}
		if lowest == 0 {
			return 0, false, nil
		}
		toBlock = lowest - 1
	}
	return 0, false, nil
}

// canonicalHeaders reads the canonical header for each requested height in one
// batched read and returns them by block number. Callers wrap the error with
// the contract and the window they were reading.
func (j *Job) canonicalHeaders(ctx context.Context, blockNumbers []int64) (map[int64]string, error) {
	requested := make([]uint64, 0, len(blockNumbers))
	for _, number := range blockNumbers {
		requested = append(requested, uint64(number))
	}

	headers, err := j.reader.BlockHeaders(ctx, requested)
	if err != nil {
		return nil, err
	}

	byNumber := make(map[int64]string, len(headers))
	for _, header := range headers {
		number, err := int64FromUint64(header.Number, "block number")
		if err != nil {
			return nil, err
		}
		byNumber[number] = header.Hash
	}
	return byNumber, nil
}
