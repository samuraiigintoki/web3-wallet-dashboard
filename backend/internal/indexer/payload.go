package indexer

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// Payload shapes written to contract_events.payload. Values wider than 64 bits
// are decimal strings, and byte strings are canonical 0x hex, so nothing in the
// stored payload depends on float or platform integer limits.

// SubmitPayload is the normalized payload of a SubmitTransaction event. The
// owner and the multisig transaction index are promoted to their own columns,
// so they are not repeated here.
type SubmitPayload struct {
	To       string `json:"to"`
	ValueWei string `json:"valueWei"`
	Data     string `json:"data"`
}

// EncodeSubmitPayload renders a submit payload for storage. The destination
// address must already be canonical lowercase, the value must fit in a uint256
// and the calldata is written as canonical 0x hex.
func EncodeSubmitPayload(to string, valueWei *big.Int, callData []byte) ([]byte, error) {
	if !IsCanonicalAddress(to) {
		return nil, fmt.Errorf("submit payload destination %q is not a canonical address", to)
	}
	value, err := FormatUint256(valueWei)
	if err != nil {
		return nil, fmt.Errorf("submit payload value: %w", err)
	}
	payload, err := json.Marshal(SubmitPayload{
		To:       to,
		ValueWei: value,
		Data:     HexBytes(callData),
	})
	if err != nil {
		return nil, fmt.Errorf("encode submit payload: %w", err)
	}
	return payload, nil
}

// DecodeSubmitPayload parses and validates a stored submit payload. It rejects
// a payload that could not have been produced by EncodeSubmitPayload.
func DecodeSubmitPayload(payload []byte) (SubmitPayload, error) {
	var decoded SubmitPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return SubmitPayload{}, fmt.Errorf("decode submit payload: %w", err)
	}
	if !IsCanonicalAddress(decoded.To) {
		return SubmitPayload{}, fmt.Errorf("submit payload destination %q is not a canonical address", decoded.To)
	}
	if _, err := ParseUint256Decimal(decoded.ValueWei); err != nil {
		return SubmitPayload{}, fmt.Errorf("submit payload value: %w", err)
	}
	if _, err := ParseHexBytes(decoded.Data); err != nil {
		return SubmitPayload{}, fmt.Errorf("submit payload data: %w", err)
	}
	return decoded, nil
}

// DecodePayloadObject rejects a payload that is not a JSON object, so a scalar
// or array cannot be stored where the schema expects an object.
func DecodePayloadObject(payload []byte) (map[string]json.RawMessage, error) {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return map[string]json.RawMessage{}, nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &object); err != nil {
		return nil, fmt.Errorf("payload is not a JSON object: %w", err)
	}
	if object == nil {
		return nil, errors.New("payload is not a JSON object")
	}
	return object, nil
}

// HexBytes renders bytes as canonical 0x-prefixed lowercase hex. Empty input
// becomes 0x rather than an empty string.
func HexBytes(data []byte) string {
	return "0x" + hex.EncodeToString(data)
}

// ParseHexBytes parses canonical 0x-prefixed hex, odd length or a missing
// prefix are rejected.
func ParseHexBytes(value string) ([]byte, error) {
	if !strings.HasPrefix(value, "0x") {
		return nil, fmt.Errorf("%q is missing the 0x prefix", value)
	}
	body := value[2:]
	if body == "" {
		return []byte{}, nil
	}
	if strings.ContainsAny(body, "ABCDEF") {
		return nil, fmt.Errorf("%q is not lowercase hex", value)
	}
	decoded, err := hex.DecodeString(body)
	if err != nil {
		return nil, fmt.Errorf("%q is not hex: %w", value, err)
	}
	return decoded, nil
}
