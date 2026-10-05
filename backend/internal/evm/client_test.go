package evm

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

// sepoliaChainID is the chain ID the deployment call site will pass. The
// unit tests reuse it so the fake and the integration test agree on one
// value.
const sepoliaChainID = 11155111

// errRPC stands in for any failure a live endpoint could return.
var errRPC = errors.New("rpc failure")

// fakeReader is a scriptable ChainReader for client metadata tests. Zero
// metadata values mean "succeed with zero"; contract calls are unexpected.
// The header, batched header and log fields are filled by the tests that cover
// log retrieval.
type fakeReader struct {
	chainID          uint64
	blockNumber      uint64
	chainIDErr       error
	blockNumErr      error
	receipt          Receipt
	receiptErr       error
	receiptHash      *string
	estimateGas      uint64
	estimateGasErr   error
	estimateRequest  *GasEstimateRequest
	estimateGasCalls *int

	header       BlockHeader
	headerErr    error
	headerNumber *uint64
	headerCalls  *int

	headers      []BlockHeader
	headersErr   error
	headersInput *[]uint64
	headersCalls *int

	logs        []RawLog
	logsErr     error
	filterInput *LogFilter
	filterCalls *int
}

func (f fakeReader) ChainID(context.Context) (uint64, error) {
	return f.chainID, f.chainIDErr
}

func (f fakeReader) BlockNumber(context.Context) (uint64, error) {
	return f.blockNumber, f.blockNumErr
}

func (f fakeReader) BlockHeader(ctx context.Context, blockNumber uint64) (BlockHeader, error) {
	if err := ctx.Err(); err != nil {
		return BlockHeader{}, err
	}
	if f.headerNumber != nil {
		*f.headerNumber = blockNumber
	}
	if f.headerCalls != nil {
		(*f.headerCalls)++
	}
	return f.header, f.headerErr
}

func (f fakeReader) BlockHeaders(ctx context.Context, blockNumbers []uint64) ([]BlockHeader, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.headersInput != nil {
		*f.headersInput = append([]uint64(nil), blockNumbers...)
	}
	if f.headersCalls != nil {
		(*f.headersCalls)++
	}
	if f.headersErr != nil {
		return nil, f.headersErr
	}
	return append([]BlockHeader(nil), f.headers...), nil
}

func (f fakeReader) FilterLogs(ctx context.Context, filter LogFilter) ([]RawLog, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.filterInput != nil {
		copied := filter
		copied.Topics = make([][]string, len(filter.Topics))
		for i, group := range filter.Topics {
			copied.Topics[i] = append([]string(nil), group...)
		}
		*f.filterInput = copied
	}
	if f.filterCalls != nil {
		(*f.filterCalls)++
	}
	if f.logsErr != nil {
		return nil, f.logsErr
	}
	return append([]RawLog(nil), f.logs...), nil
}

func (fakeReader) CallContract(context.Context, string, []byte, uint64) ([]byte, error) {
	return nil, errors.New("unexpected contract call in client test")
}

func (f fakeReader) TransactionReceipt(ctx context.Context, txHash string) (Receipt, error) {
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}
	if f.receiptHash != nil {
		*f.receiptHash = txHash
	}
	return f.receipt, f.receiptErr
}

func (f fakeReader) EstimateGas(ctx context.Context, request GasEstimateRequest) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if f.estimateRequest != nil {
		*f.estimateRequest = request
	}
	if f.estimateGasCalls != nil {
		(*f.estimateGasCalls)++
	}
	return f.estimateGas, f.estimateGasErr
}

func TestNewWithReaderHappyPath(t *testing.T) {
	ctx := t.Context()
	fake := fakeReader{chainID: sepoliaChainID, blockNumber: 11831568}

	c, err := newWithReader(ctx, fake, sepoliaChainID)
	if err != nil {
		t.Fatalf("newWithReader() = %v, want nil", err)
	}

	id, err := c.ChainID(ctx)
	if err != nil {
		t.Fatalf("ChainID() = %v, want nil", err)
	}
	if id != sepoliaChainID {
		t.Errorf("ChainID() = %d, want %d", id, sepoliaChainID)
	}

	n, err := c.BlockNumber(ctx)
	if err != nil {
		t.Fatalf("BlockNumber() = %v, want nil", err)
	}
	if n != 11831568 {
		t.Errorf("BlockNumber() = %d, want 11831568", n)
	}
}

func TestNewWithReaderChainIDMismatch(t *testing.T) {
	ctx := t.Context()
	fake := fakeReader{chainID: 1}

	_, err := newWithReader(ctx, fake, sepoliaChainID)
	if err == nil {
		t.Fatal("newWithReader() = nil, want a mismatch error")
	}
	for _, want := range []string{"chain ID mismatch", "endpoint serves 1", "configuration expects 11155111"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestNewWithReaderChainIDError(t *testing.T) {
	ctx := t.Context()
	fake := fakeReader{chainIDErr: errRPC}

	_, err := newWithReader(ctx, fake, sepoliaChainID)
	if err == nil {
		t.Fatal("newWithReader() = nil, want the reader error")
	}
	if !errors.Is(err, errRPC) {
		t.Errorf("error %v does not wrap the reader error", err)
	}
}

func TestNewWithReaderRejectsNonPositiveChainID(t *testing.T) {
	ctx := t.Context()
	fake := fakeReader{chainID: sepoliaChainID}

	for _, expected := range []int64{0, -1} {
		if _, err := newWithReader(ctx, fake, expected); err == nil {
			t.Errorf("newWithReader(expected=%d) = nil, want an error", expected)
		}
	}
}

func TestClientMethodErrors(t *testing.T) {
	ctx := t.Context()
	c := &Client{reader: fakeReader{chainIDErr: errRPC, blockNumErr: errRPC}}

	if _, err := c.ChainID(ctx); !errors.Is(err, errRPC) {
		t.Errorf("ChainID() error %v does not wrap the reader error", err)
	}
	if _, err := c.BlockNumber(ctx); !errors.Is(err, errRPC) {
		t.Errorf("BlockNumber() error %v does not wrap the reader error", err)
	}
}

func TestClientCloseClosesTransport(t *testing.T) {
	closed := false
	c := &Client{
		closeTransport: func() { closed = true },
	}

	c.Close()
	if !closed {
		t.Fatal("Close() did not close the transport")
	}
}

func TestNewRejectsEmptyURL(t *testing.T) {
	ctx := t.Context()

	if _, err := New(ctx, "", sepoliaChainID); err == nil {
		t.Fatal("New() = nil, want an error for an empty URL")
	}
}

// TestIntegration dials the real Sepolia endpoint through Alchemy. It runs only when
// EVM_RPC_URL is set, the same gate the Postgres integration tests use.
func TestIntegration(t *testing.T) {
	rpcURL := os.Getenv("EVM_RPC_URL")
	if rpcURL == "" {
		t.Skip("skipping integration test:EVM_RPC_URL not set")
	}
	ctx := t.Context()

	c, err := New(ctx, rpcURL, sepoliaChainID)
	if err != nil {
		t.Fatalf("New() = %v, want nil", err)
	}
	defer c.Close()

	id, err := c.ChainID(ctx)
	if err != nil {
		t.Fatalf("ChainID() = %v, want nil", err)
	}
	if id != sepoliaChainID {
		t.Errorf("ChainID() = %d, want %d", id, sepoliaChainID)
	}

	n, err := c.BlockNumber(ctx)
	if err != nil {
		t.Fatalf("BlockNumber() = %v, want nil", err)
	}
	if n == 0 {
		t.Error("BlockNumber() = 0, want a positive block height")
	}
}
