package evm

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

const multisigFixtureAddress = "0x5B324F41E5889cf94CbA8e909089683a1a97c318"

type scriptedCall struct {
	method  string
	args    []interface{}
	outputs []interface{}
	raw     []byte
	err     error
}

type recordedContractCall struct {
	address string
	method  string
	args    []interface{}
	block   uint64
}

type contractTestReader struct {
	chainID          uint64
	blockNumber      uint64
	chainIDErr       error
	blockNumberErr   error
	blockNumberCalls int
	responses        []scriptedCall
	calls            []recordedContractCall
}

func (r *contractTestReader) ChainID(context.Context) (uint64, error) {
	return r.chainID, r.chainIDErr
}

func (r *contractTestReader) BlockNumber(context.Context) (uint64, error) {
	r.blockNumberCalls++
	return r.blockNumber, r.blockNumberErr
}

func (r *contractTestReader) TransactionReceipt(ctx context.Context, _ string) (Receipt, error) {
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}
	return Receipt{}, errors.New("unexpected transaction receipt call in multisig test")
}

func (r *contractTestReader) EstimateGas(ctx context.Context, _ GasEstimateRequest) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return 0, errors.New("unexpected gas estimate call in multisig test")
}

func (r *contractTestReader) CallContract(ctx context.Context, address string, callData []byte, block uint64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(callData) < 4 {
		return nil, errors.New("call data is shorter than a method selector")
	}
	parsedABI, err := abi.JSON(strings.NewReader(multiSigReadABI))
	if err != nil {
		return nil, fmt.Errorf("parse test ABI: %w", err)
	}
	method, err := parsedABI.MethodById(callData[:4])
	if err != nil {
		return nil, fmt.Errorf("decode method selector: %w", err)
	}
	args, err := method.Inputs.Unpack(callData[4:])
	if err != nil {
		return nil, fmt.Errorf("decode %s arguments: %w", method.Name, err)
	}
	r.calls = append(r.calls, recordedContractCall{
		address: address,
		method:  method.Name,
		args:    args,
		block:   block,
	})
	if len(r.responses) == 0 {
		return nil, fmt.Errorf("unexpected eth_call to %s", method.Name)
	}
	response := r.responses[0]
	r.responses = r.responses[1:]
	if response.method != method.Name {
		return nil, fmt.Errorf("unexpected method %s, want %s", method.Name, response.method)
	}
	if len(args) != len(response.args) {
		return nil, fmt.Errorf("%s received %d args, want %d", method.Name, len(args), len(response.args))
	}
	for i := range args {
		if !reflect.DeepEqual(args[i], response.args[i]) {
			return nil, fmt.Errorf("%s arg %d = %#v, want %#v", method.Name, i, args[i], response.args[i])
		}
	}
	if response.err != nil {
		return nil, response.err
	}
	if response.raw != nil {
		return append([]byte(nil), response.raw...), nil
	}
	return method.Outputs.Pack(response.outputs...)
}

func newContractTestReader(t *testing.T, block uint64, responses ...scriptedCall) (*MultiSigReader, *contractTestReader) {
	t.Helper()
	fake := &contractTestReader{
		chainID:     sepoliaChainID,
		blockNumber: block,
		responses:   append([]scriptedCall(nil), responses...),
	}
	client, err := newWithReader(t.Context(), fake, sepoliaChainID)
	if err != nil {
		t.Fatalf("newWithReader() = %v, want nil", err)
	}
	reader, err := NewMultiSigReader(client, multisigFixtureAddress)
	if err != nil {
		t.Fatalf("NewMultiSigReader() = %v, want nil", err)
	}
	return reader, fake
}

func assertCallsConsumed(t *testing.T, fake *contractTestReader) {
	t.Helper()
	if len(fake.responses) != 0 {
		t.Errorf("%d scripted RPC responses were not used", len(fake.responses))
	}
}

func TestNewMultiSigReaderValidatesAndNormalizesAddress(t *testing.T) {
	client, err := newWithReader(t.Context(), fakeReader{chainID: sepoliaChainID}, sepoliaChainID)
	if err != nil {
		t.Fatalf("newWithReader() = %v, want nil", err)
	}

	if _, err := NewMultiSigReader(nil, multisigFixtureAddress); err == nil {
		t.Fatal("NewMultiSigReader(nil, ...) = nil error, want an error")
	}
	if _, err := NewMultiSigReader(&Client{}, multisigFixtureAddress); err == nil {
		t.Fatal("NewMultiSigReader(uninitialized client, ...) = nil error, want an error")
	}
	for _, address := range []string{"", "not-an-address", "0x1234", "0x0000000000000000000000000000000000000000"} {
		if _, err := NewMultiSigReader(client, address); err == nil {
			t.Errorf("NewMultiSigReader(address=%q) = nil error, want an error", address)
		}
	}

	reader, err := NewMultiSigReader(client, "0X5B324F41E5889cF94cBA8e909089683A1a97c318")
	if err != nil {
		t.Fatalf("NewMultiSigReader(valid mixed-case address) = %v, want nil", err)
	}
	if reader.contract != strings.ToLower(multisigFixtureAddress) {
		t.Errorf("reader.contract = %q, want lowercase %q", reader.contract, strings.ToLower(multisigFixtureAddress))
	}
}

func TestMultiSigReaderOwners(t *testing.T) {
	owner1 := common.HexToAddress("0x14912965632cd9AB70C046e8D23e9b8dfA9f2746")
	owner2 := common.HexToAddress("0x00000000000000000000000000000000000000a2")
	reader, fake := newContractTestReader(t, 810, scriptedCall{
		method:  "getOwners",
		args:    []interface{}{},
		outputs: []interface{}{[]common.Address{owner1, owner2}},
	})

	owners, err := reader.Owners(t.Context())
	if err != nil {
		t.Fatalf("Owners() = %v, want nil", err)
	}
	want := []string{strings.ToLower(owner1.Hex()), strings.ToLower(owner2.Hex())}
	if !reflect.DeepEqual(owners, want) {
		t.Errorf("Owners() = %#v, want %#v", owners, want)
	}
	if fake.blockNumberCalls != 1 {
		t.Errorf("BlockNumber calls = %d, want 1", fake.blockNumberCalls)
	}
	if len(fake.calls) != 1 || fake.calls[0].block != 810 || fake.calls[0].address != strings.ToLower(multisigFixtureAddress) {
		t.Errorf("eth_call records = %#v, want one call to the normalized contract at block 810", fake.calls)
	}
	assertCallsConsumed(t, fake)
}

func TestMultiSigReaderThresholdAndTransactionCount(t *testing.T) {
	t.Run("threshold", func(t *testing.T) {
		reader, fake := newContractTestReader(t, 811, scriptedCall{
			method:  "threshold",
			args:    []interface{}{},
			outputs: []interface{}{big.NewInt(2)},
		})
		got, err := reader.Threshold(t.Context())
		if err != nil {
			t.Fatalf("Threshold() = %v, want nil", err)
		}
		if got != 2 {
			t.Errorf("Threshold() = %d, want 2", got)
		}
		assertCallsConsumed(t, fake)
	})

	t.Run("transaction count", func(t *testing.T) {
		reader, fake := newContractTestReader(t, 812, scriptedCall{
			method:  "getTransactionCount",
			args:    []interface{}{},
			outputs: []interface{}{big.NewInt(19)},
		})
		got, err := reader.TransactionCount(t.Context())
		if err != nil {
			t.Fatalf("TransactionCount() = %v, want nil", err)
		}
		if got != 19 {
			t.Errorf("TransactionCount() = %d, want 19", got)
		}
		assertCallsConsumed(t, fake)
	})
}

func TestMultiSigReaderIsOwner(t *testing.T) {
	owner := "0x14912965632cd9AB70C046e8D23e9b8dfA9f2746"
	reader, fake := newContractTestReader(t, 813,
		scriptedCall{
			method:  "isOwner",
			args:    []interface{}{common.HexToAddress(owner)},
			outputs: []interface{}{true},
		},
		scriptedCall{
			method:  "isOwner",
			args:    []interface{}{common.Address{}},
			outputs: []interface{}{false},
		},
	)
	got, err := reader.IsOwner(t.Context(), owner)
	if err != nil {
		t.Fatalf("IsOwner() = %v, want nil", err)
	}
	if !got {
		t.Fatal("IsOwner() = false, want true")
	}
	got, err = reader.IsOwner(t.Context(), "0x0000000000000000000000000000000000000000")
	if err != nil {
		t.Fatalf("IsOwner(zero address) = %v, want nil", err)
	}
	if got {
		t.Error("IsOwner(zero address) = true, want false")
	}
	assertCallsConsumed(t, fake)

	before := len(fake.calls)
	if _, err := reader.IsOwner(t.Context(), "invalid"); err == nil {
		t.Fatal("IsOwner(invalid address) = nil error, want an error")
	}
	if len(fake.calls) != before {
		t.Errorf("invalid IsOwner address made %d RPC call(s), want none", len(fake.calls)-before)
	}
}

func TestMultiSigReaderTransactionPreservesExactValueAndBytes(t *testing.T) {
	index := uint64(2)
	to := common.HexToAddress("0x00000000000000000000000000000000000000b2")
	largeValue := new(big.Int).Lsh(big.NewInt(1), 220)
	largeValue.Add(largeValue, big.NewInt(1234567))
	data := []byte{0x00, 0x01, 0xff, 0x80}
	reader, fake := newContractTestReader(t, 900, scriptedCall{
		method:  "getTransactionCount",
		args:    []interface{}{},
		outputs: []interface{}{big.NewInt(3)},
	}, scriptedCall{
		method:  "transactions",
		args:    []interface{}{new(big.Int).SetUint64(index)},
		outputs: []interface{}{to, largeValue, data, true},
	})

	got, err := reader.Transaction(t.Context(), index)
	if err != nil {
		t.Fatalf("Transaction(%d) = %v, want nil", index, err)
	}
	if got.To != strings.ToLower(to.Hex()) {
		t.Errorf("Transaction.To = %q, want %q", got.To, strings.ToLower(to.Hex()))
	}
	if got.ValueWei == nil || got.ValueWei.Cmp(largeValue) != 0 {
		t.Errorf("Transaction.ValueWei = %v, want %s", got.ValueWei, largeValue)
	}
	if !reflect.DeepEqual(got.Data, data) {
		t.Errorf("Transaction.Data = %x, want %x", got.Data, data)
	}
	if !got.Executed {
		t.Error("Transaction.Executed = false, want true")
	}
	if fake.blockNumberCalls != 1 {
		t.Errorf("BlockNumber calls = %d, want 1", fake.blockNumberCalls)
	}
	if len(fake.calls) != 2 || fake.calls[0].block != 900 || fake.calls[1].block != 900 {
		t.Errorf("transaction calls used blocks %#v, want both at 900", fake.calls)
	}
	assertCallsConsumed(t, fake)
}

func TestMultiSigReaderTransactionRejectsOutOfRangeIndex(t *testing.T) {
	reader, fake := newContractTestReader(t, 901, scriptedCall{
		method:  "getTransactionCount",
		args:    []interface{}{},
		outputs: []interface{}{big.NewInt(2)},
	})
	_, err := reader.Transaction(t.Context(), 2)
	if !errors.Is(err, ErrTransactionNotFound) {
		t.Fatalf("Transaction(out of range) error = %v, want ErrTransactionNotFound", err)
	}
	if len(fake.calls) != 1 {
		t.Errorf("out-of-range Transaction made %d eth_call(s), want only the count call", len(fake.calls))
	}
	assertCallsConsumed(t, fake)
}

func TestMultiSigReaderConfirmationsUsesOneBlockAndOwnerOrder(t *testing.T) {
	owner1 := common.HexToAddress("0x0000000000000000000000000000000000000011")
	owner2 := common.HexToAddress("0x0000000000000000000000000000000000000022")
	owner3 := common.HexToAddress("0x0000000000000000000000000000000000000033")
	index := uint64(1)
	reader, fake := newContractTestReader(t, 902,
		scriptedCall{method: "getTransactionCount", args: []interface{}{}, outputs: []interface{}{big.NewInt(4)}},
		scriptedCall{method: "getOwners", args: []interface{}{}, outputs: []interface{}{[]common.Address{owner2, owner1, owner3}}},
		scriptedCall{method: "isConfirmed", args: []interface{}{new(big.Int).SetUint64(index), owner2}, outputs: []interface{}{true}},
		scriptedCall{method: "isConfirmed", args: []interface{}{new(big.Int).SetUint64(index), owner1}, outputs: []interface{}{false}},
		scriptedCall{method: "isConfirmed", args: []interface{}{new(big.Int).SetUint64(index), owner3}, outputs: []interface{}{true}},
	)

	got, err := reader.Confirmations(t.Context(), index)
	if err != nil {
		t.Fatalf("Confirmations(%d) = %v, want nil", index, err)
	}
	if got.BlockNumber != 902 {
		t.Errorf("BlockNumber = %d, want 902", got.BlockNumber)
	}
	wantStatuses := []OwnerConfirmation{
		{Owner: strings.ToLower(owner2.Hex()), Confirmed: true},
		{Owner: strings.ToLower(owner1.Hex()), Confirmed: false},
		{Owner: strings.ToLower(owner3.Hex()), Confirmed: true},
	}
	if !reflect.DeepEqual(got.Owners, wantStatuses) {
		t.Errorf("Owners = %#v, want %#v", got.Owners, wantStatuses)
	}
	if got.ConfirmedCount != 2 {
		t.Errorf("ConfirmedCount = %d, want 2", got.ConfirmedCount)
	}
	if fake.blockNumberCalls != 1 {
		t.Errorf("BlockNumber calls = %d, want 1", fake.blockNumberCalls)
	}
	for _, call := range fake.calls {
		if call.block != got.BlockNumber {
			t.Errorf("%s call used block %d, want %d", call.method, call.block, got.BlockNumber)
		}
	}
	assertCallsConsumed(t, fake)
}

func TestMultiSigReaderConfirmationsRejectsOutOfRangeIndex(t *testing.T) {
	reader, fake := newContractTestReader(t, 903, scriptedCall{
		method:  "getTransactionCount",
		args:    []interface{}{},
		outputs: []interface{}{big.NewInt(1)},
	})
	_, err := reader.Confirmations(t.Context(), 1)
	if !errors.Is(err, ErrTransactionNotFound) {
		t.Fatalf("Confirmations(out of range) error = %v, want ErrTransactionNotFound", err)
	}
	if len(fake.calls) != 1 {
		t.Errorf("out-of-range Confirmations made %d eth_call(s), want only the count call", len(fake.calls))
	}
	assertCallsConsumed(t, fake)
}

func TestMultiSigReaderRejectsUint256Overflow(t *testing.T) {
	overflow := new(big.Int).Lsh(big.NewInt(1), 64)
	for _, tc := range []struct {
		name   string
		method string
		read   func(*MultiSigReader) (uint64, error)
	}{
		{name: "threshold", method: "threshold", read: func(m *MultiSigReader) (uint64, error) { return m.Threshold(t.Context()) }},
		{name: "transaction count", method: "getTransactionCount", read: func(m *MultiSigReader) (uint64, error) { return m.TransactionCount(t.Context()) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader, fake := newContractTestReader(t, 904, scriptedCall{
				method:  tc.method,
				args:    []interface{}{},
				outputs: []interface{}{new(big.Int).Set(overflow)},
			})
			if _, err := tc.read(reader); err == nil || !strings.Contains(err.Error(), "overflows uint64") {
				t.Fatalf("read() error = %v, want uint64 overflow", err)
			}
			assertCallsConsumed(t, fake)
		})
	}
}

func TestMultiSigReaderWrapsRPCAndDecodeErrors(t *testing.T) {
	t.Run("rpc error", func(t *testing.T) {
		reader, fake := newContractTestReader(t, 905, scriptedCall{
			method: "getOwners",
			args:   []interface{}{},
			err:    errRPC,
		})
		_, err := reader.Owners(t.Context())
		if !errors.Is(err, errRPC) {
			t.Fatalf("Owners() error = %v, want wrapped RPC error", err)
		}
		if !strings.Contains(err.Error(), "getOwners") {
			t.Errorf("Owners() error %q lacks method context", err)
		}
		assertCallsConsumed(t, fake)
	})

	t.Run("decode error", func(t *testing.T) {
		reader, fake := newContractTestReader(t, 906, scriptedCall{
			method: "threshold",
			args:   []interface{}{},
			raw:    []byte{0x01},
		})
		_, err := reader.Threshold(t.Context())
		if err == nil {
			t.Fatal("Threshold() = nil error, want ABI decode error")
		}
		for _, want := range []string{"threshold", "decode result"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("Threshold() error %q does not include %q", err, want)
			}
		}
		assertCallsConsumed(t, fake)
	})
}
