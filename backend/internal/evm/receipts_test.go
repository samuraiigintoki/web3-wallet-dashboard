package evm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
)

const (
	receiptTestTxHash    = "0xb84eb64b139a63ef537ec2c30574fce3ec26cc6903127f47eea7f9297513118c"
	receiptTestBlockHash = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	estimateTestFrom     = "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746"
	estimateTestTo       = "0x5b324f41e5889cf94cba8e909089683a1a97c318"
)

func TestClientTransactionReceiptNormalizesHashesAndReturnsStatusData(t *testing.T) {
	for _, status := range []uint64{0, 1} {
		t.Run(map[uint64]string{0: "failed receipt is data", 1: "successful receipt"}[status], func(t *testing.T) {
			seenHash := ""
			reader := fakeReader{
				receipt: Receipt{
					TransactionHash: strings.ToUpper(receiptTestTxHash),
					BlockHash:       strings.ToUpper(receiptTestBlockHash),
					BlockNumber:     42,
					Status:          status,
					GasUsed:         90000,
				},
				receiptHash: &seenHash,
			}
			client := &Client{reader: reader}

			got, err := client.TransactionReceipt(t.Context(), strings.ToUpper(receiptTestTxHash))
			if err != nil {
				t.Fatalf("TransactionReceipt() error = %v, want nil", err)
			}
			if seenHash != receiptTestTxHash {
				t.Errorf("reader received hash %q, want normalized %q", seenHash, receiptTestTxHash)
			}
			if got.TransactionHash != receiptTestTxHash || got.BlockHash != receiptTestBlockHash {
				t.Errorf("receipt hashes = (%q, %q), want (%q, %q)", got.TransactionHash, got.BlockHash, receiptTestTxHash, receiptTestBlockHash)
			}
			if got.BlockNumber != 42 || got.Status != status || got.GasUsed != 90000 {
				t.Errorf("receipt metadata = %#v, want block 42 status %d gas 90000", got, status)
			}
		})
	}
}

func TestClientTransactionReceiptRejectsInvalidHashWithoutCallingReader(t *testing.T) {
	for _, hash := range []string{"", "0x1234", "0x" + strings.Repeat("g", 64), strings.Repeat("a", 63)} {
		t.Run(hash, func(t *testing.T) {
			seenHash := "not called"
			client := &Client{reader: fakeReader{receiptHash: &seenHash}}
			if _, err := client.TransactionReceipt(t.Context(), hash); err == nil {
				t.Fatal("TransactionReceipt() error = nil, want validation error")
			}
			if seenHash != "not called" {
				t.Errorf("reader received invalid hash %q", seenHash)
			}
		})
	}
}

func TestClientTransactionReceiptRejectsMalformedReceipt(t *testing.T) {
	cases := []struct {
		name    string
		receipt Receipt
	}{
		{
			name: "mismatched transaction hash",
			receipt: Receipt{
				TransactionHash: "0x" + strings.Repeat("11", 32),
				BlockHash:       receiptTestBlockHash,
				Status:          1,
			},
		},
		{
			name: "malformed transaction hash",
			receipt: Receipt{
				TransactionHash: "not-a-hash",
				BlockHash:       receiptTestBlockHash,
				Status:          1,
			},
		},
		{
			name: "missing block hash",
			receipt: Receipt{
				TransactionHash: receiptTestTxHash,
				Status:          1,
			},
		},
		{
			name: "zero block hash",
			receipt: Receipt{
				TransactionHash: receiptTestTxHash,
				BlockHash:       "0x" + strings.Repeat("0", 64),
				Status:          1,
			},
		},
		{
			name: "unknown status",
			receipt: Receipt{
				TransactionHash: receiptTestTxHash,
				BlockHash:       receiptTestBlockHash,
				Status:          2,
			},
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			client := &Client{reader: fakeReader{receipt: test.receipt}}
			if _, err := client.TransactionReceipt(t.Context(), receiptTestTxHash); err == nil {
				t.Fatal("TransactionReceipt() error = nil, want malformed receipt error")
			}
		})
	}
}

func TestClientTransactionReceiptWrapsNotFoundAndRPCError(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "not found", err: ErrReceiptNotFound},
		{name: "RPC failure", err: errRPC},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &Client{reader: fakeReader{receiptErr: test.err}}
			_, err := client.TransactionReceipt(t.Context(), receiptTestTxHash)
			if !errors.Is(err, test.err) {
				t.Errorf("TransactionReceipt() error = %v, want it to wrap %v", err, test.err)
			}
		})
	}
}

func TestReceiptFromGethChecksBlockNumberAndStatus(t *testing.T) {
	valid := &types.Receipt{
		TxHash:      common.HexToHash(receiptTestTxHash),
		BlockHash:   common.HexToHash(receiptTestBlockHash),
		BlockNumber: big.NewInt(42),
		Status:      1,
		GasUsed:     21000,
	}
	got, err := (ethclientReader{}).receiptFromGeth(valid)
	if err != nil {
		t.Fatalf("receiptFromGeth() error = %v, want nil", err)
	}
	if got.TransactionHash != receiptTestTxHash || got.BlockHash != receiptTestBlockHash || got.BlockNumber != 42 || got.Status != 1 || got.GasUsed != 21000 {
		t.Errorf("receiptFromGeth() = %#v, want the converted receipt", got)
	}

	cases := []struct {
		name    string
		receipt *types.Receipt
	}{
		{name: "nil receipt", receipt: nil},
		{name: "nil block number", receipt: &types.Receipt{BlockNumber: nil}},
		{name: "block number overflow", receipt: &types.Receipt{BlockNumber: new(big.Int).Lsh(big.NewInt(1), 64)}},
		{name: "negative block number", receipt: &types.Receipt{BlockNumber: big.NewInt(-1)}},
		{name: "invalid status", receipt: &types.Receipt{BlockNumber: big.NewInt(1), Status: 2}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := (ethclientReader{}).receiptFromGeth(test.receipt); err == nil {
				t.Fatal("receiptFromGeth() error = nil, want validation error")
			}
		})
	}
}

func TestClientEstimateGasNormalizesAndCopiesArguments(t *testing.T) {
	value := big.NewInt(12)
	data := []byte{0x12, 0x34, 0x56}
	var received GasEstimateRequest
	calls := 0
	client := &Client{reader: fakeReader{
		estimateGas:      123456,
		estimateRequest:  &received,
		estimateGasCalls: &calls,
	}}

	gas, err := client.EstimateGas(t.Context(), GasEstimateRequest{
		From:     "0X14912965632CD9AB70C046E8D23E9B8DFA9F2746",
		To:       "0X5B324F41E5889CF94CBA8E909089683A1A97C318",
		ValueWei: value,
		Data:     data,
	})
	if err != nil {
		t.Fatalf("EstimateGas() error = %v, want nil", err)
	}
	if gas != 123456 {
		t.Errorf("EstimateGas() = %d gas units, want 123456", gas)
	}
	if received.From != estimateTestFrom || received.To != estimateTestTo {
		t.Errorf("reader addresses = (%q, %q), want (%q, %q)", received.From, received.To, estimateTestFrom, estimateTestTo)
	}
	if received.ValueWei == nil || received.ValueWei.Cmp(big.NewInt(12)) != 0 {
		t.Errorf("reader valueWei = %v, want 12", received.ValueWei)
	}
	if string(received.Data) != string([]byte{0x12, 0x34, 0x56}) {
		t.Errorf("reader data = %x, want 123456", received.Data)
	}
	if calls != 1 {
		t.Errorf("EstimateGas reader calls = %d, want 1", calls)
	}

	value.SetInt64(99)
	data[0] = 0xff
	if received.ValueWei.Cmp(big.NewInt(12)) != 0 {
		t.Errorf("reader value changed after caller mutation: %s", received.ValueWei)
	}
	if received.Data[0] != 0x12 {
		t.Errorf("reader data changed after caller mutation: %x", received.Data)
	}
}

func TestClientEstimateGasNilValueMeansZeroAndAcceptsUint256Max(t *testing.T) {
	var received GasEstimateRequest
	client := &Client{reader: fakeReader{estimateGas: 1, estimateRequest: &received}}
	if _, err := client.EstimateGas(t.Context(), GasEstimateRequest{From: estimateTestFrom, To: estimateTestTo}); err != nil {
		t.Fatalf("EstimateGas(nil value) error = %v, want nil", err)
	}
	if received.ValueWei == nil || received.ValueWei.Sign() != 0 {
		t.Errorf("nil ValueWei became %v, want a non-nil zero", received.ValueWei)
	}

	max := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	if _, err := client.EstimateGas(t.Context(), GasEstimateRequest{From: estimateTestFrom, To: estimateTestTo, ValueWei: max}); err != nil {
		t.Errorf("EstimateGas(uint256 max) error = %v, want nil", err)
	}
}

func TestClientEstimateGasRejectsInvalidArgumentsBeforeRPC(t *testing.T) {
	tooLarge := new(big.Int).Lsh(big.NewInt(1), 256)
	negative := big.NewInt(-1)
	cases := []struct {
		name    string
		request GasEstimateRequest
	}{
		{name: "malformed from", request: GasEstimateRequest{From: "bad", To: estimateTestTo}},
		{name: "zero from", request: GasEstimateRequest{From: "0x" + strings.Repeat("0", 40), To: estimateTestTo}},
		{name: "malformed to", request: GasEstimateRequest{From: estimateTestFrom, To: "bad"}},
		{name: "zero to", request: GasEstimateRequest{From: estimateTestFrom, To: "0x" + strings.Repeat("0", 40)}},
		{name: "negative value", request: GasEstimateRequest{From: estimateTestFrom, To: estimateTestTo, ValueWei: negative}},
		{name: "value exceeds uint256", request: GasEstimateRequest{From: estimateTestFrom, To: estimateTestTo, ValueWei: tooLarge}},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			client := &Client{reader: fakeReader{estimateGasCalls: &calls}}
			if _, err := client.EstimateGas(t.Context(), test.request); err == nil {
				t.Fatal("EstimateGas() error = nil, want validation error")
			}
			if calls != 0 {
				t.Errorf("reader calls = %d, want 0 for invalid input", calls)
			}
		})
	}
}

func TestClientEstimateGasWrapsRPCAndContextErrors(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "RPC failure", err: errRPC},
		{name: "canceled context", err: context.Canceled},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			if errors.Is(test.err, context.Canceled) {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			client := &Client{reader: fakeReader{estimateGasErr: test.err}}
			_, err := client.EstimateGas(ctx, GasEstimateRequest{From: estimateTestFrom, To: estimateTestTo})
			if !errors.Is(err, test.err) {
				t.Errorf("EstimateGas() error = %v, want it to wrap %v", err, test.err)
			}
		})
	}
}

func TestClientB3MethodsRejectNilClient(t *testing.T) {
	var client *Client
	if _, err := client.TransactionReceipt(t.Context(), receiptTestTxHash); err == nil {
		t.Error("TransactionReceipt() on nil client returned no error")
	}
	if _, err := client.EstimateGas(t.Context(), GasEstimateRequest{}); err == nil {
		t.Error("EstimateGas() on nil client returned no error")
	}
}

type rpcTestRequest struct {
	ID     json.RawMessage   `json:"id"`
	Method string            `json:"method"`
	Params []json.RawMessage `json:"params"`
}

func writeRPCResult(w http.ResponseWriter, id json.RawMessage, result any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	}); err != nil {
		_, _ = fmt.Fprintln(w, err)
	}
}

func TestEthclientReaderTransactionReceiptMapsNotFound(t *testing.T) {
	requests := make(chan rpcTestRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var request rpcTestRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, "bad JSON-RPC request", http.StatusBadRequest)
			return
		}
		requests <- request
		writeRPCResult(w, request.ID, nil)
	}))
	defer server.Close()

	rpcClient, err := rpc.DialHTTP(server.URL)
	if err != nil {
		t.Fatalf("rpc.DialHTTP() = %v, want nil", err)
	}
	client := ethclient.NewClient(rpcClient)
	defer client.Close()

	reader := ethclientReader{c: client}
	_, err = reader.TransactionReceipt(t.Context(), receiptTestTxHash)
	if !errors.Is(err, ErrReceiptNotFound) {
		t.Fatalf("TransactionReceipt() error = %v, want ErrReceiptNotFound", err)
	}
	request := <-requests
	if request.Method != "eth_getTransactionReceipt" {
		t.Errorf("JSON-RPC method = %q, want eth_getTransactionReceipt", request.Method)
	}
	if len(request.Params) != 1 {
		t.Errorf("JSON-RPC params = %d, want one transaction hash", len(request.Params))
	}
}

func TestEthclientReaderEstimateGasMapsPlainRequest(t *testing.T) {
	type estimateArgs struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Value string `json:"value"`
		Input string `json:"input"`
	}
	requests := make(chan struct {
		request rpcTestRequest
		args    estimateArgs
	}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var request rpcTestRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, "bad JSON-RPC request", http.StatusBadRequest)
			return
		}
		var args estimateArgs
		if len(request.Params) > 0 {
			if err := json.Unmarshal(request.Params[0], &args); err != nil {
				http.Error(w, "bad eth_estimateGas args", http.StatusBadRequest)
				return
			}
		}
		requests <- struct {
			request rpcTestRequest
			args    estimateArgs
		}{request: request, args: args}
		writeRPCResult(w, request.ID, "0x5208")
	}))
	defer server.Close()

	rpcClient, err := rpc.DialHTTP(server.URL)
	if err != nil {
		t.Fatalf("rpc.DialHTTP() = %v, want nil", err)
	}
	client := ethclient.NewClient(rpcClient)
	defer client.Close()

	reader := ethclientReader{c: client}
	gas, err := reader.EstimateGas(t.Context(), GasEstimateRequest{
		From:     estimateTestFrom,
		To:       estimateTestTo,
		ValueWei: big.NewInt(12),
		Data:     []byte{0x12, 0x34, 0x56},
	})
	if err != nil {
		t.Fatalf("EstimateGas() error = %v, want nil", err)
	}
	if gas != 21000 {
		t.Errorf("EstimateGas() = %d, want 21000", gas)
	}
	captured := <-requests
	if captured.request.Method != "eth_estimateGas" {
		t.Errorf("JSON-RPC method = %q, want eth_estimateGas", captured.request.Method)
	}
	if len(captured.request.Params) != 1 {
		t.Errorf("JSON-RPC params = %d, want one call message", len(captured.request.Params))
	}
	if strings.ToLower(captured.args.From) != estimateTestFrom || strings.ToLower(captured.args.To) != estimateTestTo {
		t.Errorf("RPC from/to = (%q, %q), want (%q, %q)", captured.args.From, captured.args.To, estimateTestFrom, estimateTestTo)
	}
	if captured.args.Value != "0xc" {
		t.Errorf("RPC value = %q, want 0xc", captured.args.Value)
	}
	if captured.args.Input != "0x123456" {
		t.Errorf("RPC input = %q, want 0x123456", captured.args.Input)
	}
}

func TestClientTransactionReceiptPreservesContextError(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	client := &Client{reader: fakeReader{}}
	_, err := client.TransactionReceipt(ctx, receiptTestTxHash)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("TransactionReceipt() error = %v, want context.Canceled", err)
	}
}
