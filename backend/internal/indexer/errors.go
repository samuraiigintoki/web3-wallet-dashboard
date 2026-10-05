package indexer

import (
	"errors"
	"fmt"
)

// ValidationError reports a rejected input field.
type ValidationError struct {
	Field   string
	Message string
}

func (e ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

var (
	// ErrContractNotFound means no global contract row has the requested id.
	ErrContractNotFound = errors.New("indexer: contract not found")
	// ErrCheckpointNotFound means the contract has no checkpoint row yet.
	ErrCheckpointNotFound = errors.New("indexer: checkpoint not found")
	// ErrCheckpointGap means a commit would start above the stored next block,
	// which would skip an unindexed range.
	ErrCheckpointGap = errors.New("indexer: commit range starts after the checkpoint next block")
	// ErrConflictingBlockHash means a stored canonical block has a different hash
	// than the committed header, which is a chain divergence, not a new range.
	ErrConflictingBlockHash = errors.New("indexer: stored block hash differs from the committed block hash")
	// ErrAncestorNotFound means a rewind target is not present in the indexed
	// blocks, so there is no stored ancestor to rewind to.
	ErrAncestorNotFound = errors.New("indexer: ancestor block is not indexed for this contract")
	// ErrCheckpointNotIndexable means the checkpoint is disabled or unsupported,
	// so no range may be committed for it.
	ErrCheckpointNotIndexable = errors.New("indexer: checkpoint status does not accept range commits")
)
