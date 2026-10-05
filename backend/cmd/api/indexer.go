package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/evm"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/indexer"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/worker"
)

const (
	// sepoliaChainID is the network contract indexing reads. The endpoint must
	// serve it: a scanner pointed at another network would write the wrong
	// chain's logs into the checkpoints and events.
	sepoliaChainID int64 = 11155111

	// indexerInterval is how often the scanner looks for new blocks. It sits
	// well inside the worker's ten second run timeout, so a run that overruns
	// is reported as a failed range rather than delaying the next tick.
	indexerInterval = 15 * time.Second

	// indexerVerifyTimeout bounds the startup chain-ID check, so an endpoint
	// that neither answers nor refuses cannot hold startup open.
	indexerVerifyTimeout = 10 * time.Second
)

// indexerWorker couples the scanner to the RPC transport it reads through, so
// the two are released in one order: the worker handshake first, then the
// transport it may still be using.
type indexerWorker struct {
	worker *worker.Worker
	client *evm.Client
}

// Stop stops the scanner and closes the RPC transport. It is safe on a nil
// receiver, which is how the disabled case is represented, so the caller does
// not need a branch.
func (i *indexerWorker) Stop() error {
	if i == nil {
		return nil
	}
	err := i.worker.Stop()
	i.client.Close()
	return err
}

// startIndexer prepares the contract indexer. Indexing is optional: without
// EVM_RPC_URL the API serves every other feature and the scanner never runs,
// which is reported as a single warning rather than a failure. With it, the
// endpoint must answer and must serve Sepolia, and any problem there fails
// startup the same way an unreachable DATABASE_URL does.
//
// The URL is used to dial and to redact itself out of failure messages. It is
// never logged.
func startIndexer(ctx context.Context, repo indexer.Repository, logger *slog.Logger) (*indexerWorker, error) {
	rpcURL := os.Getenv("EVM_RPC_URL")
	if rpcURL == "" {
		logger.Warn("EVM_RPC_URL is not set: contract indexing is disabled")
		return nil, nil
	}

	verifyCtx, cancel := context.WithTimeout(ctx, indexerVerifyTimeout)
	defer cancel()

	// evm.New dials, verifies the served chain and closes the transport itself
	// when the check fails, so a rejected endpoint leaves nothing open behind.
	client, err := evm.New(verifyCtx, rpcURL, sepoliaChainID)
	if err != nil {
		return nil, fmt.Errorf("EVM endpoint is unusable: %w", indexer.SanitizeError(err, rpcURL))
	}

	// A checkpoint left in running belongs to a process that stopped in the
	// middle of a range. The commit that would have advanced it never
	// happened, so the range is simply scanned again.
	reset, err := repo.ResetRunningCheckpoints(ctx)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("reset stale indexer checkpoints: %w", err)
	}
	if reset > 0 {
		logger.Info("stale indexer checkpoints reset", "count", reset)
	}

	job, err := indexer.NewJob(repo, client, sepoliaChainID, rpcURL, logger)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("build indexer job: %w", err)
	}

	scanner := worker.New(job, logger, indexerInterval)
	scanner.Start()
	logger.Info("contract indexer started", "chainId", sepoliaChainID, "interval", indexerInterval)
	return &indexerWorker{worker: scanner, client: client}, nil
}
