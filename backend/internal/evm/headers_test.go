package evm

import (
	"errors"
	"fmt"
	"io"
	"math/big"
	"slices"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rpc"
)

const headerTestParent = "0x00000000000000000000000000000000000000000000000000000000000000aa"

func gethHeader(number int64, parentHash string) *types.Header {
	return &types.Header{
		Number:     big.NewInt(number),
		ParentHash: common.HexToHash(parentHash),
		Time:       1700000000 + uint64(number),
		GasLimit:   30000000,
	}
}

func TestHeaderFromGeth(t *testing.T) {
	valid := gethHeader(100, headerTestParent)

	got, err := headerFromGeth(valid)
	if err != nil {
		t.Fatalf("headerFromGeth() = %v, want nil", err)
	}
	if got.Number != 100 {
		t.Errorf("Number = %d, want 100", got.Number)
	}
	if got.Hash != strings.ToLower(valid.Hash().Hex()) {
		t.Errorf("Hash = %q, want the lowercase header hash %q", got.Hash, strings.ToLower(valid.Hash().Hex()))
	}
	if got.ParentHash != headerTestParent {
		t.Errorf("ParentHash = %q, want %q", got.ParentHash, headerTestParent)
	}
	if len(got.Hash) != 66 || got.Hash[:2] != "0x" {
		t.Errorf("Hash = %q, want a 0x-prefixed 32-byte hex string", got.Hash)
	}

	genesis, err := headerFromGeth(gethHeader(0, "0x"+strings.Repeat("0", 64)))
	if err != nil {
		t.Fatalf("headerFromGeth(genesis) = %v, want nil", err)
	}
	if genesis.ParentHash != "0x"+strings.Repeat("0", 64) {
		t.Errorf("genesis ParentHash = %q, want the zero hash", genesis.ParentHash)
	}

	tests := map[string]struct {
		header *types.Header
		want   string
	}{
		"nil header":       {header: nil, want: "nil header"},
		"nil number":       {header: &types.Header{}, want: "without a number"},
		"negative number":  {header: &types.Header{Number: big.NewInt(-1)}, want: "negative"},
		"oversized number": {header: &types.Header{Number: new(big.Int).Lsh(big.NewInt(1), 64)}, want: "does not fit uint64"},
		"zero parent above genesis": {
			header: gethHeader(5, "0x"+strings.Repeat("0", 64)),
			want:   "zero parent hash",
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := headerFromGeth(tt.header)
			if err == nil {
				t.Fatal("headerFromGeth() = nil, want an error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error %q does not mention %q", err, tt.want)
			}
		})
	}
}

func TestNewHeaderBatchArgs(t *testing.T) {
	batch := newHeaderBatch([]uint64{0, 100})
	if len(batch) != 2 {
		t.Fatalf("batch length = %d, want 2", len(batch))
	}
	for i, want := range []string{"0x0", "0x64"} {
		if batch[i].Method != "eth_getBlockByNumber" {
			t.Errorf("batch[%d].Method = %q, want eth_getBlockByNumber", i, batch[i].Method)
		}
		if len(batch[i].Args) != 2 {
			t.Fatalf("batch[%d] has %d arguments, want 2", i, len(batch[i].Args))
		}
		if batch[i].Args[0] != want {
			t.Errorf("batch[%d].Args[0] = %v, want %s", i, batch[i].Args[0], want)
		}
		if full, ok := batch[i].Args[1].(bool); !ok || full {
			t.Errorf("batch[%d].Args[1] = %v, want false so transactions are not requested", i, batch[i].Args[1])
		}
		if _, ok := batch[i].Result.(**types.Header); !ok {
			t.Errorf("batch[%d].Result type = %T, want **types.Header", i, batch[i].Result)
		}
	}
}

func TestHeadersFromBatch(t *testing.T) {
	blockNumbers := []uint64{5, 6}

	t.Run("converts every item in request order", func(t *testing.T) {
		fifth := gethHeader(5, headerTestParent)
		sixth := gethHeader(6, strings.ToLower(fifth.Hash().Hex()))
		// Descending request: the returned slice must follow the requested heights,
		// not the numeric order of the blocks.
		batch := []rpc.BatchElem{
			{Method: "eth_getBlockByNumber", Result: pointerTo(sixth)},
			{Method: "eth_getBlockByNumber", Result: pointerTo(fifth)},
		}

		headers, err := headersFromBatch(batch, []uint64{6, 5})
		if err != nil {
			t.Fatalf("headersFromBatch() = %v, want nil", err)
		}
		if len(headers) != 2 {
			t.Fatalf("headers = %d, want 2", len(headers))
		}
		if headers[0].Number != 6 || headers[1].Number != 5 {
			t.Errorf("headers returned in request order %d, %d; want 6, 5", headers[0].Number, headers[1].Number)
		}
		if headers[0].ParentHash != strings.ToLower(fifth.Hash().Hex()) {
			t.Errorf("headers[0].ParentHash = %q, want block 5 hash", headers[0].ParentHash)
		}
		if headers[1].ParentHash != headerTestParent {
			t.Errorf("headers[1].ParentHash = %q, want %q", headers[1].ParentHash, headerTestParent)
		}
	})

	t.Run("per item error is reported for that block", func(t *testing.T) {
		batch := []rpc.BatchElem{
			{Method: "eth_getBlockByNumber", Result: pointerTo(gethHeader(5, headerTestParent))},
			{Method: "eth_getBlockByNumber", Error: io.ErrUnexpectedEOF},
		}
		_, err := headersFromBatch(batch, blockNumbers)
		if err == nil {
			t.Fatal("headersFromBatch() = nil, want the item error")
		}
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Errorf("error %v does not wrap the item error", err)
		}
		if !strings.Contains(err.Error(), "block 6") {
			t.Errorf("error %q does not name the failing block", err)
		}
	})

	t.Run("missing results map to ErrBlockNotFound", func(t *testing.T) {
		// newHeaderBatch stores a pointer to a nil header, which is what a null
		// JSON result decodes into.
		missing := []rpc.BatchElem{{Method: "eth_getBlockByNumber", Result: new(*types.Header)}}
		_, err := headersFromBatch(missing, []uint64{6})
		if !errors.Is(err, ErrBlockNotFound) {
			t.Errorf("nil result error = %v, want ErrBlockNotFound", err)
		}

		noResult := []rpc.BatchElem{{Method: "eth_getBlockByNumber", Error: rpc.ErrNoResult}}
		_, err = headersFromBatch(noResult, []uint64{6})
		if !errors.Is(err, ErrBlockNotFound) {
			t.Errorf("ErrNoResult error = %v, want ErrBlockNotFound", err)
		}
	})

	t.Run("rejects mismatches", func(t *testing.T) {
		cases := map[string]struct {
			batch        []rpc.BatchElem
			blockNumbers []uint64
			want         string
		}{
			"length mismatch": {
				batch:        []rpc.BatchElem{{Method: "eth_getBlockByNumber", Result: pointerTo(gethHeader(5, headerTestParent))}},
				blockNumbers: []uint64{5, 6},
				want:         "elements for",
			},
			"unexpected result type": {
				batch:        []rpc.BatchElem{{Method: "eth_getBlockByNumber", Result: new(string)}},
				blockNumbers: []uint64{5},
				want:         "unexpected result type",
			},
			"number mismatch": {
				batch:        []rpc.BatchElem{{Method: "eth_getBlockByNumber", Result: pointerTo(gethHeader(7, headerTestParent))}},
				blockNumbers: []uint64{5},
				want:         "returned block 7",
			},
		}
		for name, tt := range cases {
			t.Run(name, func(t *testing.T) {
				_, err := headersFromBatch(tt.batch, tt.blockNumbers)
				if err == nil {
					t.Fatal("headersFromBatch() = nil, want an error")
				}
				if !strings.Contains(err.Error(), tt.want) {
					t.Errorf("error %q does not mention %q", err, tt.want)
				}
			})
		}
	})
}

func TestValidateHeaderBatch(t *testing.T) {
	if err := validateHeaderBatch([]uint64{0, 1, 2}); err != nil {
		t.Errorf("validateHeaderBatch(range) = %v, want nil", err)
	}
	atMaximum := make([]uint64, MaxHeaderBatch)
	for i := range atMaximum {
		atMaximum[i] = uint64(i)
	}
	if err := validateHeaderBatch(atMaximum); err != nil {
		t.Errorf("validateHeaderBatch(maximum) = %v, want nil", err)
	}
	if err := validateHeaderBatch([]uint64{1, 2, 3}); err != nil {
		t.Errorf("validateHeaderBatch(ascending) = %v, want nil", err)
	}

	overMax := make([]uint64, MaxHeaderBatch+1)
	for i := range overMax {
		overMax[i] = uint64(i)
	}
	if err := validateHeaderBatch(overMax); err == nil {
		t.Error("validateHeaderBatch(too large) = nil, want an error")
	}
	if err := validateHeaderBatch(nil); err == nil {
		t.Error("validateHeaderBatch(empty) = nil, want an error")
	}
	if err := validateHeaderBatch([]uint64{4, 4}); err == nil {
		t.Error("validateHeaderBatch(duplicates) = nil, want an error")
	}
}

func TestClientBlockHeader(t *testing.T) {
	ctx := t.Context()

	t.Run("passes the requested height through", func(t *testing.T) {
		var requested uint64
		want := BlockHeader{Number: 42, Hash: "0x" + strings.Repeat("ab", 32), ParentHash: headerTestParent}
		c := &Client{reader: fakeReader{header: want, headerNumber: &requested}}

		got, err := c.BlockHeader(ctx, 42)
		if err != nil {
			t.Fatalf("BlockHeader() = %v, want nil", err)
		}
		if got != want {
			t.Errorf("BlockHeader() = %+v, want %+v", got, want)
		}
		if requested != 42 {
			t.Errorf("reader received block %d, want 42", requested)
		}
	})

	t.Run("zero hash is rejected", func(t *testing.T) {
		c := &Client{reader: fakeReader{header: BlockHeader{Number: 42, Hash: "0x" + strings.Repeat("0", 64)}}}
		if _, err := c.BlockHeader(ctx, 42); err == nil {
			t.Fatal("BlockHeader() = nil, want an error for a zero hash")
		}
	})

	t.Run("number mismatch is rejected", func(t *testing.T) {
		c := &Client{reader: fakeReader{header: BlockHeader{Number: 41, Hash: "0x" + strings.Repeat("ab", 32)}}}
		if _, err := c.BlockHeader(ctx, 42); err == nil {
			t.Fatal("BlockHeader() = nil, want an error for a mismatched number")
		}
	})

	t.Run("wraps the reader error including not found", func(t *testing.T) {
		c := &Client{reader: fakeReader{headerErr: fmt.Errorf("reader: %w", ErrBlockNotFound)}}
		_, err := c.BlockHeader(ctx, 42)
		if !errors.Is(err, ErrBlockNotFound) {
			t.Errorf("error = %v, want wrapped ErrBlockNotFound", err)
		}

		c = &Client{reader: fakeReader{headerErr: errRPC}}
		if _, err := c.BlockHeader(ctx, 42); !errors.Is(err, errRPC) {
			t.Errorf("error = %v, want the wrapped reader error", err)
		}
	})

	t.Run("nil reader is rejected", func(t *testing.T) {
		if _, err := (&Client{}).BlockHeader(ctx, 42); err == nil {
			t.Fatal("BlockHeader() = nil, want an error for a nil reader")
		}
	})
}

func TestClientBlockHeaders(t *testing.T) {
	ctx := t.Context()

	t.Run("preserves request order and passes the batch through", func(t *testing.T) {
		var input []uint64
		var calls int
		headers := []BlockHeader{
			{Number: 10, Hash: "0x" + strings.Repeat("0a", 32), ParentHash: headerTestParent},
			{Number: 11, Hash: "0x" + strings.Repeat("0b", 32), ParentHash: "0x" + strings.Repeat("0a", 32)},
		}
		c := &Client{reader: fakeReader{headers: headers, headersInput: &input, headersCalls: &calls}}

		got, err := c.BlockHeaders(ctx, []uint64{10, 11})
		if err != nil {
			t.Fatalf("BlockHeaders() = %v, want nil", err)
		}
		if !slices.Equal(input, []uint64{10, 11}) {
			t.Errorf("reader received %v, want [10 11]", input)
		}
		if calls != 1 {
			t.Errorf("reader calls = %d, want 1", calls)
		}
		if !slices.Equal(got, headers) {
			t.Errorf("BlockHeaders() = %+v, want %+v", got, headers)
		}
	})

	t.Run("rejects invalid batches before calling the reader", func(t *testing.T) {
		overMax := make([]uint64, MaxHeaderBatch+1)
		cases := map[string][]uint64{
			"empty":        nil,
			"over maximum": overMax,
			"duplicates":   {3, 3},
		}
		for name, numbers := range cases {
			t.Run(name, func(t *testing.T) {
				var calls int
				c := &Client{reader: fakeReader{headersCalls: &calls}}
				if _, err := c.BlockHeaders(ctx, numbers); err == nil {
					t.Fatal("BlockHeaders() = nil, want a validation error")
				}
				if calls != 0 {
					t.Errorf("reader calls = %d, want 0 for rejected input", calls)
				}
			})
		}
	})

	t.Run("rejects a short or mismatched reader result", func(t *testing.T) {
		c := &Client{reader: fakeReader{headers: []BlockHeader{{Number: 10, Hash: "0x" + strings.Repeat("0a", 32)}}}}
		if _, err := c.BlockHeaders(ctx, []uint64{10, 11}); err == nil {
			t.Fatal("BlockHeaders() = nil, want an error for a short result")
		}

		c = &Client{reader: fakeReader{headers: []BlockHeader{{Number: 99, Hash: "0x" + strings.Repeat("0a", 32)}}}}
		if _, err := c.BlockHeaders(ctx, []uint64{10}); err == nil {
			t.Fatal("BlockHeaders() = nil, want an error for a mismatched number")
		}
	})

	t.Run("wraps the batch error", func(t *testing.T) {
		c := &Client{reader: fakeReader{headersErr: fmt.Errorf("reader: %w", ErrBlockNotFound)}}
		if _, err := c.BlockHeaders(ctx, []uint64{10}); !errors.Is(err, ErrBlockNotFound) {
			t.Errorf("error = %v, want wrapped ErrBlockNotFound", err)
		}
	})

	t.Run("nil reader is rejected", func(t *testing.T) {
		if _, err := (&Client{}).BlockHeaders(ctx, []uint64{10}); err == nil {
			t.Fatal("BlockHeaders() = nil, want an error for a nil reader")
		}
	})
}

func pointerTo(header *types.Header) **types.Header {
	return &header
}
