package evm

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// ErrTransactionNotFound reports that an index is outside the contract's
// transaction count at the block height used for the read.
var ErrTransactionNotFound = errors.New("transaction not found")

// multiSigReadABI is the minimal ABI fragment used by MultiSigReader. The
// transactions getter tuple includes its dynamic bytes field.
const multiSigReadABI = `[
  {"type":"function","name":"getOwners","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address[]","internalType":"address[]"}]},
  {"type":"function","name":"threshold","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}]},
  {"type":"function","name":"getTransactionCount","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}]},
  {"type":"function","name":"isOwner","stateMutability":"view","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}]},
  {"type":"function","name":"isConfirmed","stateMutability":"view","inputs":[{"name":"","type":"uint256","internalType":"uint256"},{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}]},
  {"type":"function","name":"transactions","stateMutability":"view","inputs":[{"name":"","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"to","type":"address","internalType":"address"},{"name":"value","type":"uint256","internalType":"uint256"},{"name":"data","type":"bytes","internalType":"bytes"},{"name":"executed","type":"bool","internalType":"bool"}]}
]`

// MultiSigReader makes typed, read-only calls to one MultiSigWallet contract.
// All addresses returned by the reader are lowercase hexadecimal strings.
type MultiSigReader struct {
	client      *Client
	contract    string
	contractABI abi.ABI
}

// Transaction is the decoded value of the contract's public transactions
// getter. ValueWei is copied so callers can safely mutate it.
type Transaction struct {
	To       string
	ValueWei *big.Int
	Data     []byte
	Executed bool
}

// OwnerConfirmation preserves the order returned by getOwners.
type OwnerConfirmation struct {
	Owner     string
	Confirmed bool
}

// ConfirmationSnapshot contains confirmation state read at one block height.
type ConfirmationSnapshot struct {
	BlockNumber    uint64
	Owners         []OwnerConfirmation
	ConfirmedCount uint64
}

// NewMultiSigReader constructs a read-only reader for a deployed contract.
// The client must have been created by New, and address must be a valid,
// non-zero Ethereum address. Valid mixed-case hex is accepted and normalized.
func NewMultiSigReader(client *Client, address string) (*MultiSigReader, error) {
	if client == nil {
		return nil, errors.New("evm: multisig reader client is nil")
	}
	if client.reader == nil {
		return nil, errors.New("evm: multisig reader client is not initialized")
	}
	contract, err := normalizeAddress(address, true)
	if err != nil {
		return nil, fmt.Errorf("evm: multisig contract address: %w", err)
	}
	parsedABI, err := abi.JSON(strings.NewReader(multiSigReadABI))
	if err != nil {
		return nil, fmt.Errorf("evm: parse embedded multisig ABI: %w", err)
	}
	return &MultiSigReader{client: client, contract: contract, contractABI: parsedABI}, nil
}

// Owners returns the contract owners in the order stored on chain.
func (m *MultiSigReader) Owners(ctx context.Context) ([]string, error) {
	block, err := m.snapshotBlock(ctx, "Owners")
	if err != nil {
		return nil, err
	}
	return m.ownersAt(ctx, block)
}

// Threshold returns the contract threshold, rejecting values that do not fit
// in uint64.
func (m *MultiSigReader) Threshold(ctx context.Context) (uint64, error) {
	outputs, err := m.read(ctx, "threshold")
	if err != nil {
		return 0, err
	}
	return decodeUint64Output(outputs, "threshold")
}

// TransactionCount returns the number of submitted transactions, rejecting
// values that do not fit in uint64.
func (m *MultiSigReader) TransactionCount(ctx context.Context) (uint64, error) {
	outputs, err := m.read(ctx, "getTransactionCount")
	if err != nil {
		return 0, err
	}
	return decodeUint64Output(outputs, "getTransactionCount")
}

// IsOwner reports whether address is one of the contract's owners.
func (m *MultiSigReader) IsOwner(ctx context.Context, address string) (bool, error) {
	owner, err := normalizeAddress(address, false)
	if err != nil {
		return false, fmt.Errorf("evm: multisig IsOwner address: %w", err)
	}
	outputs, err := m.read(ctx, "isOwner", common.HexToAddress(owner))
	if err != nil {
		return false, err
	}
	return decodeBoolOutput(outputs, "isOwner")
}

// Transaction reads one transaction at a single block height. It returns
// ErrTransactionNotFound when index is outside the count at that height.
func (m *MultiSigReader) Transaction(ctx context.Context, index uint64) (Transaction, error) {
	block, err := m.snapshotBlock(ctx, "Transaction")
	if err != nil {
		return Transaction{}, err
	}
	count, err := m.transactionCountAt(ctx, block)
	if err != nil {
		return Transaction{}, fmt.Errorf("evm: multisig Transaction: read transaction count: %w", err)
	}
	if index >= count {
		return Transaction{}, fmt.Errorf("evm: multisig Transaction: %w: index %d, count %d", ErrTransactionNotFound, index, count)
	}
	return m.transactionAt(ctx, block, index)
}

// Confirmations reads each owner's flag at one captured block height and
// derives the confirmed count from those ordered statuses.
func (m *MultiSigReader) Confirmations(ctx context.Context, index uint64) (ConfirmationSnapshot, error) {
	block, err := m.snapshotBlock(ctx, "Confirmations")
	if err != nil {
		return ConfirmationSnapshot{}, err
	}
	count, err := m.transactionCountAt(ctx, block)
	if err != nil {
		return ConfirmationSnapshot{}, fmt.Errorf("evm: multisig Confirmations: read transaction count: %w", err)
	}
	if index >= count {
		return ConfirmationSnapshot{}, fmt.Errorf("evm: multisig Confirmations: %w: index %d, count %d", ErrTransactionNotFound, index, count)
	}
	owners, err := m.ownersAt(ctx, block)
	if err != nil {
		return ConfirmationSnapshot{}, fmt.Errorf("evm: multisig Confirmations: read owners: %w", err)
	}

	result := ConfirmationSnapshot{
		BlockNumber: block,
		Owners:      make([]OwnerConfirmation, 0, len(owners)),
	}
	for _, owner := range owners {
		outputs, callErr := m.readAt(ctx, block, "isConfirmed", new(big.Int).SetUint64(index), common.HexToAddress(owner))
		if callErr != nil {
			return ConfirmationSnapshot{}, fmt.Errorf("evm: multisig Confirmations: read owner %s: %w", owner, callErr)
		}
		confirmed, decodeErr := decodeBoolOutput(outputs, "isConfirmed")
		if decodeErr != nil {
			return ConfirmationSnapshot{}, fmt.Errorf("evm: multisig Confirmations: decode owner %s: %w", owner, decodeErr)
		}
		result.Owners = append(result.Owners, OwnerConfirmation{Owner: owner, Confirmed: confirmed})
		if confirmed {
			result.ConfirmedCount++
		}
	}
	return result, nil
}

func (m *MultiSigReader) ownersAt(ctx context.Context, block uint64) ([]string, error) {
	outputs, err := m.readAt(ctx, block, "getOwners")
	if err != nil {
		return nil, err
	}
	if len(outputs) != 1 {
		return nil, fmt.Errorf("evm: multisig getOwners: decode: expected one output, got %d", len(outputs))
	}
	owners, ok := outputs[0].([]common.Address)
	if !ok {
		return nil, fmt.Errorf("evm: multisig getOwners: decode: expected []common.Address, got %T", outputs[0])
	}
	result := make([]string, len(owners))
	for i, owner := range owners {
		result[i] = strings.ToLower(owner.Hex())
	}
	return result, nil
}

func (m *MultiSigReader) transactionCountAt(ctx context.Context, block uint64) (uint64, error) {
	outputs, err := m.readAt(ctx, block, "getTransactionCount")
	if err != nil {
		return 0, err
	}
	return decodeUint64Output(outputs, "getTransactionCount")
}

func (m *MultiSigReader) transactionAt(ctx context.Context, block, index uint64) (Transaction, error) {
	outputs, err := m.readAt(ctx, block, "transactions", new(big.Int).SetUint64(index))
	if err != nil {
		return Transaction{}, fmt.Errorf("evm: multisig Transaction index %d: %w", index, err)
	}
	if len(outputs) != 4 {
		return Transaction{}, fmt.Errorf("evm: multisig transactions: decode: expected four outputs, got %d", len(outputs))
	}
	to, ok := outputs[0].(common.Address)
	if !ok {
		return Transaction{}, fmt.Errorf("evm: multisig transactions: decode target: expected common.Address, got %T", outputs[0])
	}
	value, ok := outputs[1].(*big.Int)
	if !ok || value == nil {
		return Transaction{}, fmt.Errorf("evm: multisig transactions: decode value: expected *big.Int, got %T", outputs[1])
	}
	data, ok := outputs[2].([]byte)
	if !ok {
		return Transaction{}, fmt.Errorf("evm: multisig transactions: decode data: expected []byte, got %T", outputs[2])
	}
	executed, ok := outputs[3].(bool)
	if !ok {
		return Transaction{}, fmt.Errorf("evm: multisig transactions: decode executed: expected bool, got %T", outputs[3])
	}
	return Transaction{
		To:       strings.ToLower(to.Hex()),
		ValueWei: new(big.Int).Set(value),
		Data:     append([]byte(nil), data...),
		Executed: executed,
	}, nil
}

func (m *MultiSigReader) read(ctx context.Context, method string, args ...interface{}) ([]interface{}, error) {
	block, err := m.snapshotBlock(ctx, method)
	if err != nil {
		return nil, err
	}
	return m.readAt(ctx, block, method, args...)
}

func (m *MultiSigReader) snapshotBlock(ctx context.Context, method string) (uint64, error) {
	if m == nil || m.client == nil {
		return 0, fmt.Errorf("evm: multisig %s: reader is not initialized", method)
	}
	block, err := m.client.BlockNumber(ctx)
	if err != nil {
		return 0, fmt.Errorf("evm: multisig %s: read block number: %w", method, err)
	}
	return block, nil
}

func (m *MultiSigReader) readAt(ctx context.Context, block uint64, method string, args ...interface{}) ([]interface{}, error) {
	if m == nil || m.client == nil {
		return nil, fmt.Errorf("evm: multisig %s: reader is not initialized", method)
	}
	callData, err := m.contractABI.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("evm: multisig %s: encode call: %w", method, err)
	}
	result, err := m.client.callContract(ctx, m.contract, callData, block)
	if err != nil {
		return nil, fmt.Errorf("evm: multisig %s: eth_call: %w", method, err)
	}
	outputs, err := m.contractABI.Unpack(method, result)
	if err != nil {
		return nil, fmt.Errorf("evm: multisig %s: decode result: %w", method, err)
	}
	return outputs, nil
}

func decodeUint64Output(outputs []interface{}, method string) (uint64, error) {
	if len(outputs) != 1 {
		return 0, fmt.Errorf("evm: multisig %s: decode: expected one output, got %d", method, len(outputs))
	}
	value, ok := outputs[0].(*big.Int)
	if !ok || value == nil {
		return 0, fmt.Errorf("evm: multisig %s: decode: expected uint256, got %T", method, outputs[0])
	}
	if !value.IsUint64() {
		return 0, fmt.Errorf("evm: multisig %s: uint256 value %s overflows uint64", method, value)
	}
	return value.Uint64(), nil
}

func decodeBoolOutput(outputs []interface{}, method string) (bool, error) {
	if len(outputs) != 1 {
		return false, fmt.Errorf("evm: multisig %s: decode: expected one output, got %d", method, len(outputs))
	}
	value, ok := outputs[0].(bool)
	if !ok {
		return false, fmt.Errorf("evm: multisig %s: decode: expected bool, got %T", method, outputs[0])
	}
	return value, nil
}

func normalizeAddress(address string, rejectZero bool) (string, error) {
	if len(address) >= 2 && strings.EqualFold(address[:2], "0x") {
		address = "0x" + address[2:]
	}
	if !common.IsHexAddress(address) {
		return "", fmt.Errorf("malformed hex address %q", address)
	}
	parsed := common.HexToAddress(address)
	if rejectZero && parsed == (common.Address{}) {
		return "", errors.New("zero address is not allowed")
	}
	return strings.ToLower(parsed.Hex()), nil
}
