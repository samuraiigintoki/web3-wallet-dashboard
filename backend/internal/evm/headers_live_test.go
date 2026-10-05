//go:build live

package evm

import (
	"os"
	"testing"
)

// TestHeaderAndLogReadsLive reads headers and event logs from the live Sepolia
// endpoint. It is read-only: it never signs or submits a transaction. The
// headers cover the deployment block and its neighbours, and the log read is
// bounded to that same window, so the check stays small and polite.
func TestHeaderAndLogReadsLive(t *testing.T) {
	rpcURL := os.Getenv("EVM_RPC_URL")
	if rpcURL == "" {
		t.Skip("skipping header and log live test: EVM_RPC_URL not set")
	}

	ctx := t.Context()
	client, err := New(ctx, rpcURL, sepoliaChainID)
	if err != nil {
		t.Fatalf("New() = %v, want nil", err)
	}
	defer client.Close()

	deploymentReceipt, err := client.TransactionReceipt(ctx, deploymentTransactionHash)
	if err != nil {
		t.Fatalf("TransactionReceipt() = %v, want nil", err)
	}
	deploymentBlock := deploymentReceipt.BlockNumber

	latest, err := client.BlockNumber(ctx)
	if err != nil {
		t.Fatalf("BlockNumber() = %v, want nil", err)
	}
	if deploymentBlock > latest {
		t.Fatalf("deployment block %d is above the reported head %d", deploymentBlock, latest)
	}

	single, err := client.BlockHeader(ctx, deploymentBlock)
	if err != nil {
		t.Fatalf("BlockHeader(%d) = %v, want nil", deploymentBlock, err)
	}
	if single.Number != deploymentBlock {
		t.Errorf("BlockHeader() number = %d, want %d", single.Number, deploymentBlock)
	}
	if single.Hash != deploymentReceipt.BlockHash {
		t.Errorf("BlockHeader() hash = %s, want the receipt block hash %s", single.Hash, deploymentReceipt.BlockHash)
	}

	// A bounded window that starts at the deployment block, so the parent hash of
	// each header must be the hash of the one before it.
	window := uint64(8)
	toBlock := deploymentBlock + window
	if toBlock > latest {
		window = latest - deploymentBlock
		toBlock = latest
	}
	if window == 0 {
		t.Fatalf("no block window is available around the deployment block %d", deploymentBlock)
	}

	numbers := make([]uint64, 0, window+1)
	for number := deploymentBlock; number <= toBlock; number++ {
		numbers = append(numbers, number)
	}

	headers, err := client.BlockHeaders(ctx, numbers)
	if err != nil {
		t.Fatalf("BlockHeaders(%d..%d) = %v, want nil", numbers[0], numbers[len(numbers)-1], err)
	}
	if len(headers) != len(numbers) {
		t.Fatalf("BlockHeaders() returned %d headers, want %d", len(headers), len(numbers))
	}
	for i, header := range headers {
		if header.Number != numbers[i] {
			t.Errorf("header %d number = %d, want %d", i, header.Number, numbers[i])
		}
		if i > 0 && header.ParentHash != headers[i-1].Hash {
			t.Errorf("header %d parent %s does not match the previous hash %s", i, header.ParentHash, headers[i-1].Hash)
		}
	}

	logs, err := client.FilterLogs(ctx, NewLogFilter(deploymentBlock, toBlock, multisigFixtureAddress))
	if err != nil {
		t.Fatalf("FilterLogs(%d..%d) = %v, want nil", deploymentBlock, toBlock, err)
	}

	// The fixture has no recorded multisig activity, so zero logs is a valid
	// result. Any log that does come back must match the filter and decode.
	decoder, err := NewEventDecoder(multisigFixtureAddress)
	if err != nil {
		t.Fatalf("NewEventDecoder() = %v, want nil", err)
	}
	for i, raw := range logs {
		if raw.Address != multisigFixtureAddress {
			t.Errorf("log %d address = %s, want %s", i, raw.Address, multisigFixtureAddress)
		}
		if raw.BlockNumber < deploymentBlock || raw.BlockNumber > toBlock {
			t.Errorf("log %d block = %d, want it inside %d..%d", i, raw.BlockNumber, deploymentBlock, toBlock)
		}
		if _, err := decoder.Decode(raw); err != nil {
			t.Errorf("log %d did not decode: %v", i, err)
		}
	}

	t.Logf("verified headers %d..%d and %d decoded logs at the fixture address", numbers[0], numbers[len(numbers)-1], len(logs))
}
