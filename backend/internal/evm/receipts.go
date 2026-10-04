package evm

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// ErrReceiptNotFound means no transaction receipt was available when queried.
// It does not distinguish a pending transaction from an unknown transaction.
var ErrReceiptNotFound = errors.New("transaction receipt not found")

// Receipt contains plain Go metadata for a mined transaction. Status is 0
// when execution failed and 1 when it succeeded. A failed receipt is data,
// not an RPC error.
type Receipt struct {
	TransactionHash string
	BlockHash       string
	BlockNumber     uint64
	Status          uint64
	GasUsed         uint64
}

// GasEstimateRequest describes a call to simulate for a gas estimate.
// ValueWei is copied by Client.EstimateGas and nil is treated as zero.
type GasEstimateRequest struct {
	From     string
	To       string
	ValueWei *big.Int
	Data     []byte
}

// TransactionReceipt returns a mined transaction receipt. Hashes are
// accepted as 32-byte hex strings with an optional 0x prefix and returned
// as lowercase, 0x-prefixed strings.
func (c *Client) TransactionReceipt(ctx context.Context, txHash string) (Receipt, error) {
	if c == nil || c.reader == nil {
		return Receipt{}, errors.New("evm: chain reader is nil")
	}

	hash, err := normalizeHash(txHash)
	if err != nil {
		return Receipt{}, fmt.Errorf("evm: transaction receipt hash: %w", err)
	}

	receipt, err := c.reader.TransactionReceipt(ctx, hash)
	if err != nil {
		return Receipt{}, fmt.Errorf("evm: read transaction receipt %s: %w", hash, err)
	}

	receiptHash, err := normalizeHash(receipt.TransactionHash)
	if err != nil {
		return Receipt{}, fmt.Errorf("evm: invalid receipt transaction hash: %w", err)
	}
	if isZeroHash(receiptHash) {
		return Receipt{}, errors.New("evm: receipt transaction hash is zero")
	}
	if receiptHash != hash {
		return Receipt{}, fmt.Errorf("evm: receipt transaction hash %s does not match requested hash %s", receiptHash, hash)
	}

	blockHash, err := normalizeHash(receipt.BlockHash)
	if err != nil {
		return Receipt{}, fmt.Errorf("evm: invalid receipt block hash: %w", err)
	}
	if isZeroHash(blockHash) {
		return Receipt{}, errors.New("evm: receipt block hash is zero")
	}
	if receipt.Status > 1 {
		return Receipt{}, fmt.Errorf("evm: invalid receipt status %d", receipt.Status)
	}

	receipt.TransactionHash = receiptHash
	receipt.BlockHash = blockHash
	return receipt, nil
}

// EstimateGas asks the endpoint to simulate a call and return its predicted
// gas limit. It does not sign or broadcast a transaction.
func (c *Client) EstimateGas(ctx context.Context, request GasEstimateRequest) (uint64, error) {
	if c == nil || c.reader == nil {
		return 0, errors.New("evm: chain reader is nil")
	}

	normalized, err := normalizeGasEstimateRequest(request)
	if err != nil {
		return 0, fmt.Errorf("evm: estimate gas request: %w", err)
	}

	gas, err := c.reader.EstimateGas(ctx, normalized)
	if err != nil {
		return 0, fmt.Errorf("evm: estimate gas: %w", err)
	}
	return gas, nil
}

func normalizeGasEstimateRequest(request GasEstimateRequest) (GasEstimateRequest, error) {
	from, _, err := normalizeHex(request.From, common.AddressLength)
	if err != nil {
		return GasEstimateRequest{}, fmt.Errorf("from address: %w", err)
	}
	if isZeroAddress(from) {
		return GasEstimateRequest{}, errors.New("from address is zero")
	}
	to, _, err := normalizeHex(request.To, common.AddressLength)
	if err != nil {
		return GasEstimateRequest{}, fmt.Errorf("to address: %w", err)
	}
	if isZeroAddress(to) {
		return GasEstimateRequest{}, errors.New("to address is zero")
	}

	value := new(big.Int)
	if request.ValueWei != nil {
		if request.ValueWei.Sign() < 0 {
			return GasEstimateRequest{}, errors.New("valueWei must not be negative")
		}
		if request.ValueWei.BitLen() > 256 {
			return GasEstimateRequest{}, errors.New("valueWei exceeds 256 bits")
		}
		value.Set(request.ValueWei)
	}

	return GasEstimateRequest{
		From:     from,
		To:       to,
		ValueWei: value,
		Data:     append([]byte(nil), request.Data...),
	}, nil
}

func normalizeHash(hash string) (string, error) {
	normalized, _, err := normalizeHex(hash, common.HashLength)
	if err != nil {
		return "", fmt.Errorf("invalid 32-byte hash: %w", err)
	}
	return normalized, nil
}

func normalizeHex(value string, byteLength int) (string, []byte, error) {
	if len(value) >= 2 && strings.EqualFold(value[:2], "0x") {
		value = value[2:]
	}
	if len(value) != byteLength*2 {
		return "", nil, fmt.Errorf("expected %d bytes of hexadecimal data", byteLength)
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return "", nil, fmt.Errorf("invalid hexadecimal data: %w", err)
	}
	return "0x" + hex.EncodeToString(decoded), decoded, nil
}

func isZeroHash(hash string) bool {
	return hash == "0x"+strings.Repeat("0", common.HashLength*2)
}

func isZeroAddress(address string) bool {
	return address == "0x"+strings.Repeat("0", common.AddressLength*2)
}

// TransactionReceipt adapts the plain Go ChainReader boundary to
// ethclient.TransactionReceipt. go-ethereum receipt types do not escape this
// adapter.
func (r ethclientReader) TransactionReceipt(ctx context.Context, txHash string) (Receipt, error) {
	if r.c == nil {
		return Receipt{}, errors.New("ethclient reader is nil")
	}
	hash, err := normalizeHash(txHash)
	if err != nil {
		return Receipt{}, err
	}

	got, err := r.c.TransactionReceipt(ctx, common.HexToHash(hash))
	if err != nil {
		if errors.Is(err, ethereum.NotFound) {
			return Receipt{}, ErrReceiptNotFound
		}
		return Receipt{}, err
	}
	return r.receiptFromGeth(got)
}

// EstimateGas adapts the plain Go gas request to the ethclient call message.
func (r ethclientReader) EstimateGas(ctx context.Context, request GasEstimateRequest) (uint64, error) {
	if r.c == nil {
		return 0, errors.New("ethclient reader is nil")
	}
	normalized, err := normalizeGasEstimateRequest(request)
	if err != nil {
		return 0, err
	}
	to := common.HexToAddress(normalized.To)
	call := ethereum.CallMsg{
		From:  common.HexToAddress(normalized.From),
		To:    &to,
		Value: new(big.Int).Set(normalized.ValueWei),
		Data:  append([]byte(nil), normalized.Data...),
	}
	return r.c.EstimateGas(ctx, call)
}

func (r ethclientReader) receiptFromGeth(receipt *types.Receipt) (Receipt, error) {
	if receipt == nil {
		return Receipt{}, errors.New("ethclient returned a nil receipt")
	}
	if receipt.BlockNumber == nil {
		return Receipt{}, errors.New("ethclient returned a receipt without a block number")
	}
	if !receipt.BlockNumber.IsUint64() {
		return Receipt{}, fmt.Errorf("receipt block number %s does not fit uint64", receipt.BlockNumber)
	}
	if receipt.Status > 1 {
		return Receipt{}, fmt.Errorf("ethclient returned invalid receipt status %d", receipt.Status)
	}
	return Receipt{
		TransactionHash: strings.ToLower(receipt.TxHash.Hex()),
		BlockHash:       strings.ToLower(receipt.BlockHash.Hex()),
		BlockNumber:     receipt.BlockNumber.Uint64(),
		Status:          receipt.Status,
		GasUsed:         receipt.GasUsed,
	}, nil
}
