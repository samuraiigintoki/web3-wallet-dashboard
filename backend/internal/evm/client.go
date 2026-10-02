// Package evm reads an EVM chain over JSON-RPC.
//
// This package is the only home of the go-ethereum dependency in this
// module. Nothing outside it imports go-ethereum or accepts its types;
// values cross the boundary as plain Go types, the same discipline every
// domain follows at the HTTP layer.
//
// The package never reads the environment. Callers pass the RPC endpoint
// and the expected chain ID in, so fail-closed configuration stays at the
// entrypoint that constructs the client.
package evm

import (
	"context"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/ethclient"
)

// ChainReader is the slice of an EVM JSON-RPC client this package consumes.
// It is defined on the consumer side, the same pattern as ReadinessChecker
// and RateLimiter elsewhere in this codebase, so tests can substitute a
// fake instead of a live endpoint.
type ChainReader interface {
	ChainID(ctx context.Context) (uint64, error)
	BlockNumber(ctx context.Context) (uint64, error)
}

// Client reads chain state through a ChainReader. Every method takes the
// caller's context; no default timeout hides inside this package.
type Client struct {
	reader ChainReader
}

// New dials the RPC endpoint and verifies it serves the expected chain
// before returning a usable client. A chain-ID mismatch is a returned
// error, not a panic or a log line: a client pointed at the wrong network
// must never appear to work, and the caller decides what the mismatch
// means. The expected chain ID is a parameter so the package stays
// chain-agnostic; the Sepolia call site passes 11155111, the same value
// the chains table is seeded with.
func New(ctx context.Context, rpcURL string, expectedChainID int64) (*Client, error) {
	if rpcURL == "" {
		return nil, errors.New("evm: rpc URL is empty")
	}
	ec, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("evm: dial rpc endpoint: %w", err)
	}
	c, err := newWithReader(ctx, ethclientReader{ec}, expectedChainID)
	if err != nil {
		ec.Close()
		return nil, err
	}
	return c, nil
}

// newWithReader checks the expected chain ID, reads the served one, and
// wraps the reader. New calls it with a live client; tests call it with a
// fake.
func newWithReader(ctx context.Context, reader ChainReader, expectedChainID int64) (*Client, error) {
	if expectedChainID <= 0 {
		return nil, fmt.Errorf("evm: expected chain ID must be positive, got %d", expectedChainID)
	}
	served, err := reader.ChainID(ctx)
	if err != nil {
		return nil, fmt.Errorf("evm: verify chain ID: %w", err)
	}
	if served != uint64(expectedChainID) {
		return nil, fmt.Errorf("evm: chain ID mismatch: endpoint serves %d, configuration expects %d", served, expectedChainID)
	}
	return &Client{reader: reader}, nil
}

// ChainID returns the chain ID the endpoint serves right now.
func (c *Client) ChainID(ctx context.Context) (uint64, error) {
	id, err := c.reader.ChainID(ctx)
	if err != nil {
		return 0, fmt.Errorf("evm: read chain ID: %w", err)
	}
	return id, nil
}

// BlockNumber returns the latest block number the endpoint reports.
func (c *Client) BlockNumber(ctx context.Context) (uint64, error) {
	n, err := c.reader.BlockNumber(ctx)
	if err != nil {
		return 0, fmt.Errorf("evm: read latest block number: %w", err)
	}
	return n, nil
}

// ethclientReader adapts *ethclient.Client to ChainReader. It exists
// because ethclient reports the chain ID as a *big.Int; the conversion to
// uint64 is explicit here so the interface stays in plain values.
type ethclientReader struct {
	c *ethclient.Client
}

func (r ethclientReader) ChainID(ctx context.Context) (uint64, error) {
	id, err := r.c.ChainID(ctx)
	if err != nil {
		return 0, err
	}
	if !id.IsUint64() {
		return 0, fmt.Errorf("chain ID %s does not fit uint64", id)
	}
	return id.Uint64(), nil
}

func (r ethclientReader) BlockNumber(ctx context.Context) (uint64, error) {
	return r.c.BlockNumber(ctx)
}

var _ ChainReader = ethclientReader{}
