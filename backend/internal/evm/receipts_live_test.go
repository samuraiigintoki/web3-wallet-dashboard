//go:build live

package evm

import (
	"math/big"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

const deploymentTransactionHash = "0xb84eb64b139a63ef537ec2c30574fce3ec26cc6903127f47eea7f9297513118c"

const submitTransactionABI = `[
  {"type":"function","name":"submitTransaction","stateMutability":"nonpayable","inputs":[{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"data","type":"bytes"}],"outputs":[]}
]`

func TestReceiptAndEstimateGasLive(t *testing.T) {
	rpcURL := os.Getenv("EVM_RPC_URL")
	if rpcURL == "" {
		t.Skip("skipping receipt and estimate live test: EVM_RPC_URL not set")
	}

	ctx := t.Context()
	client, err := New(ctx, rpcURL, sepoliaChainID)
	if err != nil {
		t.Fatalf("New() = %v, want nil", err)
	}
	defer client.Close()

	receipt, err := client.TransactionReceipt(ctx, deploymentTransactionHash)
	if err != nil {
		t.Fatalf("TransactionReceipt() = %v, want nil", err)
	}
	if receipt.TransactionHash != deploymentTransactionHash {
		t.Errorf("TransactionHash = %s, want %s", receipt.TransactionHash, deploymentTransactionHash)
	}
	if receipt.BlockNumber == 0 || receipt.GasUsed == 0 {
		t.Errorf("deployment receipt = %#v, want positive block number and gas used", receipt)
	}
	if receipt.Status != 1 {
		t.Fatalf("deployment receipt status = %d, want success status 1", receipt.Status)
	}

	reader, err := NewMultiSigReader(client, multisigFixtureAddress)
	if err != nil {
		t.Fatalf("NewMultiSigReader() = %v, want nil", err)
	}
	owners, err := reader.Owners(ctx)
	if err != nil {
		t.Fatalf("Owners() = %v, want nil", err)
	}
	if len(owners) != 1 {
		t.Fatalf("fixture owners = %d, want the known single owner", len(owners))
	}

	parsedABI, err := abi.JSON(strings.NewReader(submitTransactionABI))
	if err != nil {
		t.Fatalf("parse submitTransaction ABI: %v", err)
	}
	callData, err := parsedABI.Pack("submitTransaction", common.HexToAddress(multisigFixtureAddress), big.NewInt(0), []byte(nil))
	if err != nil {
		t.Fatalf("ABI-pack simulated submitTransaction call: %v", err)
	}

	gas, err := client.EstimateGas(ctx, GasEstimateRequest{
		From:     owners[0],
		To:       multisigFixtureAddress,
		ValueWei: big.NewInt(0),
		Data:     callData,
	})
	if err != nil {
		t.Fatalf("EstimateGas() = %v, want nil", err)
	}
	if gas == 0 {
		t.Error("EstimateGas() = 0, want a positive gas estimate")
	}
}
