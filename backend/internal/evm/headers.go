package evm

import (
	"context"
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rpc"
)

// ErrBlockNotFound means the endpoint served no block at the requested height.
// It does not distinguish a future block from a pruned or unsynced one, and it
// is not a retry signal.
var ErrBlockNotFound = errors.New("block not found")

// MaxHeaderBatch is the largest number of headers one batched read may request.
// It matches the scanner's bounded range, so one range needs at most one batch.
const MaxHeaderBatch = 100

// BlockHeader is the plain-Go identity of one block. Hash and ParentHash are
// lowercase, 0x-prefixed 32-byte strings.
type BlockHeader struct {
	Number     uint64
	Hash       string
	ParentHash string
}

// BlockHeader reads one block header by height. A block the endpoint does not
// have maps to ErrBlockNotFound.
func (c *Client) BlockHeader(ctx context.Context, blockNumber uint64) (BlockHeader, error) {
	if c == nil || c.reader == nil {
		return BlockHeader{}, errors.New("evm: chain reader is nil")
	}

	header, err := c.reader.BlockHeader(ctx, blockNumber)
	if err != nil {
		return BlockHeader{}, fmt.Errorf("evm: read block header %d: %w", blockNumber, err)
	}
	if err := checkHeaderNumber(header, blockNumber); err != nil {
		return BlockHeader{}, err
	}
	return header, nil
}

// BlockHeaders reads several block headers in one batched request and returns
// them in request order. Duplicate heights are rejected rather than silently
// collapsed, so a caller's ordering assumption cannot hide a bug. A failing
// item fails the call with that item's error; the batch itself is one attempt.
func (c *Client) BlockHeaders(ctx context.Context, blockNumbers []uint64) ([]BlockHeader, error) {
	if c == nil || c.reader == nil {
		return nil, errors.New("evm: chain reader is nil")
	}
	if err := validateHeaderBatch(blockNumbers); err != nil {
		return nil, err
	}

	headers, err := c.reader.BlockHeaders(ctx, blockNumbers)
	if err != nil {
		return nil, fmt.Errorf("evm: read %d block headers: %w", len(blockNumbers), err)
	}
	if len(headers) != len(blockNumbers) {
		return nil, fmt.Errorf("evm: read %d block headers, got %d", len(blockNumbers), len(headers))
	}
	for i, header := range headers {
		if err := checkHeaderNumber(header, blockNumbers[i]); err != nil {
			return nil, err
		}
	}
	return headers, nil
}

func validateHeaderBatch(blockNumbers []uint64) error {
	if len(blockNumbers) == 0 {
		return errors.New("evm: block header batch is empty")
	}
	if len(blockNumbers) > MaxHeaderBatch {
		return fmt.Errorf("evm: block header batch of %d exceeds the maximum of %d", len(blockNumbers), MaxHeaderBatch)
	}
	seen := make(map[uint64]struct{}, len(blockNumbers))
	for _, number := range blockNumbers {
		if _, duplicate := seen[number]; duplicate {
			return fmt.Errorf("evm: block header batch contains duplicate block %d", number)
		}
		seen[number] = struct{}{}
	}
	return nil
}

func checkHeaderNumber(header BlockHeader, want uint64) error {
	if header.Number != want {
		return fmt.Errorf("evm: requested block header %d, got %d", want, header.Number)
	}
	if header.Hash == "" || isZeroHash(header.Hash) {
		return fmt.Errorf("evm: block %d has an empty or zero hash", want)
	}
	return nil
}

// newHeaderBatch builds one batch element per requested height. Results are
// pointers so a null response is distinguishable from a decoded header.
func newHeaderBatch(blockNumbers []uint64) []rpc.BatchElem {
	batch := make([]rpc.BatchElem, len(blockNumbers))
	for i, number := range blockNumbers {
		batch[i] = rpc.BatchElem{
			// The second argument is false: header identity only, no transactions.
			Method: "eth_getBlockByNumber",
			Args:   []any{hexutil.EncodeUint64(number), false},
			Result: new(*types.Header),
		}
	}
	return batch
}

// headersFromBatch converts a completed batch into plain-Go headers in request
// order. The requested heights are passed alongside, so a missing or malformed
// item is reported against the height that asked for it.
func headersFromBatch(batch []rpc.BatchElem, blockNumbers []uint64) ([]BlockHeader, error) {
	if len(batch) != len(blockNumbers) {
		return nil, fmt.Errorf("evm: batch has %d elements for %d block numbers", len(batch), len(blockNumbers))
	}

	headers := make([]BlockHeader, len(batch))
	for i, elem := range batch {
		number := blockNumbers[i]
		if elem.Error != nil {
			if errors.Is(elem.Error, rpc.ErrNoResult) || errors.Is(elem.Error, ErrBlockNotFound) {
				return nil, fmt.Errorf("%w: block %d", ErrBlockNotFound, number)
			}
			return nil, fmt.Errorf("evm: batch item for block %d: %w", number, elem.Error)
		}
		header, ok := elem.Result.(**types.Header)
		if !ok {
			return nil, fmt.Errorf("evm: batch item for block %d has an unexpected result type", number)
		}
		if header == nil || *header == nil {
			return nil, fmt.Errorf("%w: block %d", ErrBlockNotFound, number)
		}
		converted, err := headerFromGeth(*header)
		if err != nil {
			return nil, fmt.Errorf("evm: batch item for block %d: %w", number, err)
		}
		if converted.Number != number {
			return nil, fmt.Errorf("evm: batch item for block %d returned block %d", number, converted.Number)
		}
		headers[i] = converted
	}
	return headers, nil
}

// headerFromGeth converts a go-ethereum header into the plain-Go type. A zero
// parent hash is accepted only for the genesis block, whose parent does not
// exist.
func headerFromGeth(header *types.Header) (BlockHeader, error) {
	if header == nil {
		return BlockHeader{}, errors.New("ethclient returned a nil header")
	}
	if header.Number == nil {
		return BlockHeader{}, errors.New("ethclient returned a header without a number")
	}
	if header.Number.Sign() < 0 {
		return BlockHeader{}, fmt.Errorf("header number %s is negative", header.Number)
	}
	if !header.Number.IsUint64() {
		return BlockHeader{}, fmt.Errorf("header number %s does not fit uint64", header.Number)
	}

	number := header.Number.Uint64()
	// The block hash is derived from the header, so shape is the only property
	// worth checking here. The client boundary rejects an empty or zero hash that
	// a reader returns.
	hash, err := normalizeHash(header.Hash().Hex())
	if err != nil {
		return BlockHeader{}, fmt.Errorf("header for block %d: %w", number, err)
	}
	parentHash, err := normalizeHash(header.ParentHash.Hex())
	if err != nil {
		return BlockHeader{}, fmt.Errorf("header for block %d: parent hash: %w", number, err)
	}
	if isZeroHash(parentHash) && number != 0 {
		return BlockHeader{}, fmt.Errorf("header for block %d has a zero parent hash", number)
	}

	return BlockHeader{Number: number, Hash: hash, ParentHash: parentHash}, nil
}

// BlockHeader adapts the plain-Go boundary to ethclient.HeaderByNumber.
func (r ethclientReader) BlockHeader(ctx context.Context, blockNumber uint64) (BlockHeader, error) {
	if r.c == nil {
		return BlockHeader{}, errors.New("ethclient reader is nil")
	}
	header, err := r.c.HeaderByNumber(ctx, new(big.Int).SetUint64(blockNumber))
	if err != nil {
		if errors.Is(err, ethereum.NotFound) {
			return BlockHeader{}, ErrBlockNotFound
		}
		return BlockHeader{}, err
	}
	return headerFromGeth(header)
}

// BlockHeaders adapts the plain-Go boundary to one JSON-RPC batch call. Batch
// item errors are inspected before results are converted, so one unavailable
// header is reported as that item's error.
func (r ethclientReader) BlockHeaders(ctx context.Context, blockNumbers []uint64) ([]BlockHeader, error) {
	if r.c == nil {
		return nil, errors.New("ethclient reader is nil")
	}
	if len(blockNumbers) == 0 {
		return nil, errors.New("ethclient batch is empty")
	}

	batch := newHeaderBatch(blockNumbers)
	if err := r.c.Client().BatchCallContext(ctx, batch); err != nil {
		return nil, err
	}
	return headersFromBatch(batch, blockNumbers)
}
