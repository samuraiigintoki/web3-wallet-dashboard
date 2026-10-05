package evm

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// reliabilityReader records every attempt and the exact caller context.
// It wraps the cause once so the client must preserve an existing error chain.
type reliabilityReader struct {
	calls   int
	context context.Context
	cause   error
}

func (r *reliabilityReader) fail(ctx context.Context) error {
	r.calls++
	r.context = ctx
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("reader: %w", err)
	}
	return fmt.Errorf("reader: %w", r.cause)
}
func (r *reliabilityReader) ChainID(ctx context.Context) (uint64, error)     { return 0, r.fail(ctx) }
func (r *reliabilityReader) BlockNumber(ctx context.Context) (uint64, error) { return 0, r.fail(ctx) }
func (r *reliabilityReader) BlockHeader(ctx context.Context, _ uint64) (BlockHeader, error) {
	return BlockHeader{}, r.fail(ctx)
}
func (r *reliabilityReader) BlockHeaders(ctx context.Context, _ []uint64) ([]BlockHeader, error) {
	return nil, r.fail(ctx)
}
func (r *reliabilityReader) CallContract(ctx context.Context, _ string, _ []byte, _ uint64) ([]byte, error) {
	return nil, r.fail(ctx)
}
func (r *reliabilityReader) FilterLogs(ctx context.Context, _ LogFilter) ([]RawLog, error) {
	return nil, r.fail(ctx)
}
func (r *reliabilityReader) TransactionReceipt(ctx context.Context, _ string) (Receipt, error) {
	return Receipt{}, r.fail(ctx)
}
func (r *reliabilityReader) EstimateGas(ctx context.Context, _ GasEstimateRequest) (uint64, error) {
	return 0, r.fail(ctx)
}

func TestClientFailuresPreserveContextAndSingleAttempt(t *testing.T) {
	operations := []struct {
		name string
		call func(context.Context, *Client) error
	}{
		{"constructor", func(ctx context.Context, c *Client) error {
			_, err := newWithReader(ctx, c.reader, sepoliaChainID)
			return err
		}},
		{"chain ID", func(ctx context.Context, c *Client) error { _, err := c.ChainID(ctx); return err }},
		{"block number", func(ctx context.Context, c *Client) error { _, err := c.BlockNumber(ctx); return err }},
		{"contract call", func(ctx context.Context, c *Client) error {
			_, err := c.callContract(ctx, multisigFixtureAddress, nil, 100)
			return err
		}},
		{"block header", func(ctx context.Context, c *Client) error {
			_, err := c.BlockHeader(ctx, 100)
			return err
		}},
		{"block headers", func(ctx context.Context, c *Client) error {
			_, err := c.BlockHeaders(ctx, []uint64{100, 101})
			return err
		}},
		{"filter logs", func(ctx context.Context, c *Client) error {
			_, err := c.FilterLogs(ctx, NewLogFilter(100, 199, multisigFixtureAddress))
			return err
		}},
		{"receipt", func(ctx context.Context, c *Client) error {
			_, err := c.TransactionReceipt(ctx, "0x"+strings.Repeat("ab", 32))
			return err
		}},
		{"gas estimate", func(ctx context.Context, c *Client) error {
			_, err := c.EstimateGas(ctx, GasEstimateRequest{From: multisigFixtureAddress, To: multisigFixtureAddress})
			return err
		}},
	}
	for _, op := range operations {
		for _, failure := range []string{"canceled", "deadline", "transport"} {
			t.Run(op.name+"/"+failure, func(t *testing.T) {
				ctx := t.Context()
				want := error(io.ErrUnexpectedEOF)
				switch failure {
				case "canceled":
					canceled, cancel := context.WithCancel(ctx)
					cancel()
					ctx, want = canceled, context.Canceled
				case "deadline":
					expired, cancel := context.WithDeadline(ctx, time.Unix(1, 0))
					defer cancel()
					ctx, want = expired, context.DeadlineExceeded
				}
				reader := &reliabilityReader{cause: want}
				err := op.call(ctx, &Client{reader: reader})
				if !errors.Is(err, want) {
					t.Fatalf("error = %v, want wrapped %v", err, want)
				}
				if reader.calls != 1 {
					t.Errorf("reader calls = %d, want 1", reader.calls)
				}
				if reader.context != ctx {
					t.Error("reader did not receive the original caller context")
				}
			})
		}
	}
}

func TestReceiptNotFoundDoesNotRetry(t *testing.T) {
	reader := &reliabilityReader{cause: ErrReceiptNotFound}
	_, err := (&Client{reader: reader}).TransactionReceipt(t.Context(), "0x"+strings.Repeat("ab", 32))
	if !errors.Is(err, ErrReceiptNotFound) {
		t.Fatalf("error = %v, want ErrReceiptNotFound", err)
	}
	if reader.calls != 1 {
		t.Fatalf("reader calls = %d, want 1", reader.calls)
	}
}

func TestMultiSigFailedSnapshotDoesNotRetry(t *testing.T) {
	owner := common.HexToAddress(multisigFixtureAddress)
	other := common.HexToAddress("0x0000000000000000000000000000000000000001")
	operations := []struct {
		name      string
		responses []scriptedCall
		call      func(context.Context, *MultiSigReader) error
	}{
		{"transaction", []scriptedCall{
			{method: "getTransactionCount", outputs: []interface{}{big.NewInt(2)}},
			{method: "transactions", args: []interface{}{big.NewInt(1)}},
		}, func(ctx context.Context, m *MultiSigReader) error { _, err := m.Transaction(ctx, 1); return err }},
		{"confirmations", []scriptedCall{
			{method: "getTransactionCount", outputs: []interface{}{big.NewInt(2)}},
			{method: "getOwners", outputs: []interface{}{[]common.Address{owner, other}}},
			{method: "isConfirmed", args: []interface{}{big.NewInt(1), owner}, outputs: []interface{}{true}},
			{method: "isConfirmed", args: []interface{}{big.NewInt(1), other}},
		}, func(ctx context.Context, m *MultiSigReader) error { _, err := m.Confirmations(ctx, 1); return err }},
	}
	for _, op := range operations {
		// Stage zero fails the block lookup; later stages fail each contract call.
		for stage := 0; stage <= len(op.responses); stage++ {
			for _, cause := range []error{context.Canceled, context.DeadlineExceeded, io.ErrUnexpectedEOF} {
				t.Run(fmt.Sprintf("%s/stage%d/%s", op.name, stage, cause), func(t *testing.T) {
					reader := &contractTestReader{blockNumber: 100}
					if stage == 0 {
						reader.blockNumberErr = fmt.Errorf("reader: %w", cause)
					} else {
						reader.responses = append([]scriptedCall(nil), op.responses[:stage]...)
						reader.responses[stage-1].err = fmt.Errorf("reader: %w", cause)
					}
					m, err := NewMultiSigReader(&Client{reader: reader}, multisigFixtureAddress)
					if err != nil {
						t.Fatal(err)
					}
					err = op.call(t.Context(), m)
					if !errors.Is(err, cause) {
						t.Fatalf("error = %v, want wrapped %v", err, cause)
					}
					if reader.blockNumberCalls != 1 {
						t.Errorf("block lookups = %d, want 1", reader.blockNumberCalls)
					}
					if len(reader.calls) != stage {
						t.Errorf("contract calls = %d, want %d", len(reader.calls), stage)
					}
					for _, call := range reader.calls {
						if call.block != 100 {
							t.Errorf("block = %d, want 100", call.block)
						}
					}
				})
			}
		}
	}
}
