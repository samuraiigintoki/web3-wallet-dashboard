package indexer

import (
	"errors"
	"math/big"
	"strings"
	"testing"
)

func TestCheckpointStatusValid(t *testing.T) {
	valid := []CheckpointStatus{StatusPending, StatusRunning, StatusIdle, StatusError, StatusDisabled, StatusUnsupported}
	for _, status := range valid {
		if !status.Valid() {
			t.Errorf("expected %q to be a valid status", status)
		}
	}

	invalid := []CheckpointStatus{"", "paused", "PENDING", " failed", "succeeded"}
	for _, status := range invalid {
		if status.Valid() {
			t.Errorf("expected %q to be rejected", status)
		}
	}
}

func TestIsSupportedEventName(t *testing.T) {
	for _, name := range []string{EventSubmitTransaction, EventConfirmTransaction, EventRevokeConfirmation, EventExecuteTransaction} {
		if !IsSupportedEventName(name) {
			t.Errorf("expected %q to be supported", name)
		}
	}
	for _, name := range []string{"", "Deposit", "submitTransaction", "Transfer"} {
		if IsSupportedEventName(name) {
			t.Errorf("expected %q to be rejected", name)
		}
	}
}

func TestParseUint256Decimal(t *testing.T) {
	maxUint256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))

	valid := map[string]string{
		"0":                     "0",
		"1":                     "1",
		"1000000000000000000":   "1000000000000000000",
		maxUint256.String():     maxUint256.String(),
		strings.Repeat("9", 77): strings.Repeat("9", 77),
	}
	for value, want := range valid {
		parsed, err := ParseUint256Decimal(value)
		if err != nil {
			t.Fatalf("parse %q: %v", value, err)
		}
		if parsed.String() != want {
			t.Errorf("parse %q: expected %s, got %s", value, want, parsed)
		}
	}

	// 2^256 and a 79 digit value are both out of range.
	tooLarge := new(big.Int).Lsh(big.NewInt(1), 256).String()
	invalid := []string{"", " ", "01", "007", "-1", "+1", "1.0", "1e18", "0x10", "one", tooLarge, strings.Repeat("9", 79)}
	for _, value := range invalid {
		if _, err := ParseUint256Decimal(value); err == nil {
			t.Errorf("expected %q to be rejected", value)
		}
	}
}

func TestFormatUint256(t *testing.T) {
	formatted, err := FormatUint256(big.NewInt(0))
	if err != nil || formatted != "0" {
		t.Fatalf("format zero: got %q, err %v", formatted, err)
	}

	maxUint256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	if _, err := FormatUint256(maxUint256); err != nil {
		t.Errorf("format max uint256: %v", err)
	}

	if _, err := FormatUint256(nil); err == nil {
		t.Error("expected nil to be rejected")
	}
	if _, err := FormatUint256(big.NewInt(-1)); err == nil {
		t.Error("expected a negative value to be rejected")
	}
	if _, err := FormatUint256(new(big.Int).Lsh(big.NewInt(1), 256)); err == nil {
		t.Error("expected an oversized value to be rejected")
	}
}

func TestHexBytesRoundTrip(t *testing.T) {
	if got := HexBytes(nil); got != "0x" {
		t.Errorf("empty bytes: expected 0x, got %q", got)
	}
	if got := HexBytes([]byte{0xde, 0xad, 0xbe, 0xef}); got != "0xdeadbeef" {
		t.Errorf("unexpected hex: %q", got)
	}

	decoded, err := ParseHexBytes("0xdeadbeef")
	if err != nil {
		t.Fatalf("parse hex: %v", err)
	}
	if HexBytes(decoded) != "0xdeadbeef" {
		t.Errorf("round trip changed the value: %q", HexBytes(decoded))
	}

	empty, err := ParseHexBytes("0x")
	if err != nil {
		t.Fatalf("parse empty hex: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("expected empty bytes, got %d bytes", len(empty))
	}

	for _, value := range []string{"deadbeef", "0xDEADBEEF", "0xabc", "0xzz"} {
		if _, err := ParseHexBytes(value); err == nil {
			t.Errorf("expected %q to be rejected", value)
		}
	}
}

func TestSubmitPayloadRoundTrip(t *testing.T) {
	to := "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746"
	valueWei, _ := new(big.Int).SetString("1000000000000000000", 10)

	payload, err := EncodeSubmitPayload(to, valueWei, []byte{0x01, 0x02})
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}

	decoded, err := DecodeSubmitPayload(payload)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if decoded.To != to {
		t.Errorf("expected destination %s, got %s", to, decoded.To)
	}
	if decoded.ValueWei != "1000000000000000000" {
		t.Errorf("expected a decimal string value, got %q", decoded.ValueWei)
	}
	if decoded.Data != "0x0102" {
		t.Errorf("expected 0x0102 calldata, got %q", decoded.Data)
	}
}

func TestPayloadEncodingRejectsInvalidInput(t *testing.T) {
	valueWei := big.NewInt(1)

	if _, err := EncodeSubmitPayload("0xABC", valueWei, nil); err == nil {
		t.Error("expected a non-canonical destination address to be rejected")
	}
	if _, err := EncodeSubmitPayload("0x14912965632cd9ab70c046e8d23e9b8dfa9f2746", big.NewInt(-1), nil); err == nil {
		t.Error("expected a negative value to be rejected")
	}

	badPayloads := map[string]string{
		"not json":       `not-json`,
		"array":          `[]`,
		"null":           `null`,
		"bad address":    `{"to":"0xABC","valueWei":"1","data":"0x"}`,
		"bad value":      `{"to":"0x14912965632cd9ab70c046e8d23e9b8dfa9f2746","valueWei":"12x","data":"0x"}`,
		"leading zero":   `{"to":"0x14912965632cd9ab70c046e8d23e9b8dfa9f2746","valueWei":"01","data":"0x"}`,
		"bad data":       `{"to":"0x14912965632cd9ab70c046e8d23e9b8dfa9f2746","valueWei":"1","data":"01"}`,
		"uppercase data": `{"to":"0x14912965632cd9ab70c046e8d23e9b8dfa9f2746","valueWei":"1","data":"0xAB"}`,
	}
	for name, payload := range badPayloads {
		if _, err := DecodeSubmitPayload([]byte(payload)); err == nil {
			t.Errorf("%s: expected decode to fail", name)
		}
	}
}

func TestDecodePayloadObject(t *testing.T) {
	if object, err := DecodePayloadObject([]byte("{}")); err != nil || len(object) != 0 {
		t.Fatalf("empty object: got %v, err %v", object, err)
	}
	if _, err := DecodePayloadObject(nil); err != nil {
		t.Fatalf("nil payload must be treated as an empty object: %v", err)
	}
	for _, payload := range []string{`[]`, `"text"`, `3`, `null`, `{`} {
		if _, err := DecodePayloadObject([]byte(payload)); err == nil {
			t.Errorf("expected %q to be rejected", payload)
		}
	}
}

func TestEventValidate(t *testing.T) {
	valid := Event{
		ContractID:       7,
		EventName:        EventConfirmTransaction,
		BlockNumber:      100,
		BlockHash:        hashFor(100, 1),
		TransactionHash:  hashFor(100, 2),
		TransactionIndex: 0,
		LogIndex:         1,
		ActorAddress:     "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746",
		MultisigTxIndex:  "0",
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected a valid event, got %v", err)
	}

	tests := map[string]func(*Event){
		"zero contract":          func(e *Event) { e.ContractID = 0 },
		"unsupported name":       func(e *Event) { e.EventName = "Deposit" },
		"negative block":         func(e *Event) { e.BlockNumber = -1 },
		"uppercase block hash":   func(e *Event) { e.BlockHash = strings.ToUpper(e.BlockHash) },
		"short transaction hash": func(e *Event) { e.TransactionHash = "0x1234" },
		"negative tx index":      func(e *Event) { e.TransactionIndex = -1 },
		"negative log index":     func(e *Event) { e.LogIndex = -1 },
		"bad actor":              func(e *Event) { e.ActorAddress = "0x1491" },
		"bad multisig index":     func(e *Event) { e.MultisigTxIndex = "1.5" },
		"scalar payload":         func(e *Event) { e.Payload = []byte(`42`) },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			event := valid
			mutate(&event)
			var validationError ValidationError
			err := event.Validate()
			if err == nil {
				t.Fatal("expected validation to fail")
			}
			if !errors.As(err, &validationError) {
				t.Fatalf("expected a ValidationError, got %T: %v", err, err)
			}
		})
	}
}

func TestRangeCommitValidate(t *testing.T) {
	contractID := int64(3)
	valid := RangeCommit{
		ContractID: contractID,
		FromBlock:  100,
		ToBlock:    101,
		Status:     StatusIdle,
		Blocks: []BlockHeader{
			{BlockNumber: 100, BlockHash: hashFor(100, 1), ParentHash: hashFor(99, 1)},
			{BlockNumber: 101, BlockHash: hashFor(101, 1), ParentHash: hashFor(100, 1)},
		},
		Events: []Event{
			{
				ContractID: contractID, EventName: EventConfirmTransaction,
				BlockNumber: 100, BlockHash: hashFor(100, 1), TransactionHash: hashFor(100, 2),
				TransactionIndex: 0, LogIndex: 0, ActorAddress: "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746",
				MultisigTxIndex: "1",
			},
			{
				ContractID: contractID, EventName: EventExecuteTransaction,
				BlockNumber: 101, BlockHash: hashFor(101, 1), TransactionHash: hashFor(101, 2),
				TransactionIndex: 1, LogIndex: 0, ActorAddress: "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746",
				MultisigTxIndex: "1",
			},
		},
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected a valid commit, got %v", err)
	}

	tests := map[string]func(*RangeCommit){
		"zero contract":       func(c *RangeCommit) { c.ContractID = 0 },
		"negative from":       func(c *RangeCommit) { c.FromBlock = -1 },
		"inverted range":      func(c *RangeCommit) { c.ToBlock = 99 },
		"running status":      func(c *RangeCommit) { c.Status = StatusRunning },
		"missing header":      func(c *RangeCommit) { c.Blocks = c.Blocks[:1] },
		"non contiguous":      func(c *RangeCommit) { c.Blocks[1].BlockNumber = 200 },
		"bad header hash":     func(c *RangeCommit) { c.Blocks[1].BlockHash = "0x1234" },
		"bad parent hash":     func(c *RangeCommit) { c.Blocks[0].ParentHash = "nope" },
		"foreign event":       func(c *RangeCommit) { c.Events[0].ContractID = contractID + 1 },
		"event outside range": func(c *RangeCommit) { c.Events[1].BlockNumber = 105 },
		"event hash mismatch": func(c *RangeCommit) { c.Events[1].BlockHash = hashFor(101, 9) },
		"removed event":       func(c *RangeCommit) { c.Events[0].Removed = true },
		"out of order":        func(c *RangeCommit) { c.Events[0], c.Events[1] = c.Events[1], c.Events[0] },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			commit := valid
			mutate(&commit)
			if err := commit.Validate(); err == nil {
				t.Fatal("expected validation to fail")
			}
		})
	}
}

func TestEventConstructors(t *testing.T) {
	contractID := int64(9)
	meta := EventMetadata{
		BlockNumber:      120,
		BlockHash:        hashFor(120, 1),
		TransactionHash:  hashFor(120, 2),
		TransactionIndex: 2,
		LogIndex:         3,
	}

	submit, err := NewSubmitTransactionEvent(contractID, meta, "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746", 5, "0x000000000000000000000000000000000000dead", big.NewInt(42), []byte{0xab})
	if err != nil {
		t.Fatalf("build submit event: %v", err)
	}
	if submit.EventName != EventSubmitTransaction || submit.MultisigTxIndex != "5" {
		t.Fatalf("unexpected submit event: %+v", submit)
	}
	payload, err := DecodeSubmitPayload(submit.Payload)
	if err != nil {
		t.Fatalf("decode built payload: %v", err)
	}
	if payload.ValueWei != "42" || payload.Data != "0xab" {
		t.Errorf("unexpected payload: %+v", payload)
	}

	confirm, err := NewOwnerEvent(contractID, meta, EventConfirmTransaction, "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746", 5)
	if err != nil {
		t.Fatalf("build confirm event: %v", err)
	}
	if confirm.EventName != EventConfirmTransaction || confirm.MultisigTxIndex != "5" {
		t.Fatalf("unexpected confirm event: %+v", confirm)
	}
	if object, err := DecodePayloadObject(confirm.Payload); err != nil || len(object) != 0 {
		t.Fatalf("expected an empty object payload, got %s (%v)", confirm.Payload, err)
	}

	if _, err := NewOwnerEvent(contractID, meta, EventSubmitTransaction, "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746", 5); err == nil {
		t.Error("expected SubmitTransaction to be rejected by NewOwnerEvent")
	}
	if _, err := NewOwnerEvent(contractID, meta, "Deposit", "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746", 5); err == nil {
		t.Error("expected an unsupported event name to be rejected")
	}
	if _, err := NewOwnerEvent(contractID, meta, EventConfirmTransaction, "0xABC", 5); err == nil {
		t.Error("expected a non-canonical owner to be rejected")
	}
	if _, err := NewSubmitTransactionEvent(contractID, meta, "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746", 5, "0xABC", big.NewInt(1), nil); err == nil {
		t.Error("expected a non-canonical destination to be rejected")
	}
}

// hashFor builds a deterministic canonical 32-byte hash for tests.
func hashFor(number int64, tag int) string {
	return "0x" + hexString(64, uint64(number)*1000+uint64(tag))
}

// hexString builds a fixed-width lowercase hex string without the 0x prefix.
// The width is counted in hex characters.
func hexString(width int, value uint64) string {
	const digits = "0123456789abcdef"
	buffer := make([]byte, width)
	for index := range buffer {
		buffer[index] = '0'
	}
	for position := width - 1; position >= 0 && value > 0; position-- {
		buffer[position] = digits[value&0xf]
		value >>= 4
	}
	return string(buffer)
}
