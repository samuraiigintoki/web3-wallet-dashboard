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
type fakeReader struct {
	chainID     uint64
	blockNumber uint64
	chainIDErr  error
	blockNumErr error
}

func (f fakeReader) ChainID(context.Context) (uint64, error) {
	return f.chainID, f.chainIDErr
}

func (f fakeReader) BlockNumber(context.Context) (uint64, error) {
	return f.blockNumber, f.blockNumErr
}

func (fakeReader) CallContract(context.Context, string, []byte, uint64) ([]byte, error) {
	return nil, errors.New("unexpected contract call in client test")
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
