//go:build live

package evm

import (
	"os"
	"testing"
)

func TestMultiSigIntegration(t *testing.T) {
	rpcURL := os.Getenv("EVM_RPC_URL")
	if rpcURL == "" {
		t.Skip("skipping multisig integration test: EVM_RPC_URL not set")
	}
	ctx := t.Context()
	client, err := New(ctx, rpcURL, sepoliaChainID)
	if err != nil {
		t.Fatalf("New() = %v, want nil", err)
	}
	defer client.Close()

	reader, err := NewMultiSigReader(client, multisigFixtureAddress)
	if err != nil {
		t.Fatalf("NewMultiSigReader() = %v, want nil", err)
	}
	owners, err := reader.Owners(ctx)
	if err != nil {
		t.Fatalf("Owners() = %v, want nil", err)
	}
	if len(owners) != 1 {
		t.Fatalf("Owners() returned %d owners, want the known fixture owner", len(owners))
	}
	threshold, err := reader.Threshold(ctx)
	if err != nil {
		t.Fatalf("Threshold() = %v, want nil", err)
	}
	if threshold != 1 {
		t.Errorf("Threshold() = %d, want 1", threshold)
	}
	isOwner, err := reader.IsOwner(ctx, owners[0])
	if err != nil {
		t.Fatalf("IsOwner() = %v, want nil", err)
	}
	if !isOwner {
		t.Errorf("IsOwner(%s) = false, want true", owners[0])
	}
	count, err := reader.TransactionCount(ctx)
	if err != nil {
		t.Fatalf("TransactionCount() = %v, want nil", err)
	}
	t.Logf("fixture transaction count: %d", count)
	if count > 0 {
		transaction, err := reader.Transaction(ctx, 0)
		if err != nil {
			t.Fatalf("Transaction(0) = %v, want nil", err)
		}
		if transaction.ValueWei == nil || transaction.To == "" {
			t.Errorf("Transaction(0) = %#v, want target and value", transaction)
		}
		snapshot, err := reader.Confirmations(ctx, 0)
		if err != nil {
			t.Fatalf("Confirmations(0) = %v, want nil", err)
		}
		if snapshot.BlockNumber == 0 {
			t.Error("Confirmations(0).BlockNumber = 0, want a positive block")
		}
		if len(snapshot.Owners) != len(owners) {
			t.Errorf("Confirmations(0) returned %d owner statuses, want %d", len(snapshot.Owners), len(owners))
		}
	}
}
