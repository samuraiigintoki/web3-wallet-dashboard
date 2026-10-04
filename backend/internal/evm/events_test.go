package evm

import (
	"bytes"
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

const (
	eventTestContractAddress = "0x5B324F41E5889cf94CbA8e909089683a1a97c318"
	eventTestOwnerAddress    = "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746"
	eventTestBlockHash       = "0x1111111111111111111111111111111111111111111111111111111111111111"
	eventTestTransactionHash = "0x2222222222222222222222222222222222222222222222222222222222222222"
)

func TestNewEventDecoderValidatesAndNormalizesAddress(t *testing.T) {
	decoder, err := NewEventDecoder(strings.ToUpper(eventTestContractAddress))
	if err != nil {
		t.Fatalf("NewEventDecoder(valid address) = %v, want nil", err)
	}
	if decoder.contractAddress != strings.ToLower(eventTestContractAddress) {
		t.Errorf("decoder.contractAddress = %q, want lowercase %q", decoder.contractAddress, strings.ToLower(eventTestContractAddress))
	}

	for _, address := range []string{"", "not-an-address", "0x1234", "0x0000000000000000000000000000000000000000"} {
		if _, err := NewEventDecoder(address); err == nil {
			t.Errorf("NewEventDecoder(%q) = nil error, want error", address)
		}
	}
}

func TestEventDecoderDecodesAllSupportedEvents(t *testing.T) {
	owner := common.HexToAddress(eventTestOwnerAddress)
	largeValue := new(big.Int).Lsh(big.NewInt(1), 200)
	largeValue.Add(largeValue, big.NewInt(17))
	callData := []byte{0x12, 0x00, 0xfe, 0x34}

	tests := []struct {
		name          string
		indexed       []interface{}
		nonIndexed    []interface{}
		removed       bool
		wantIndex     uint64
		wantEventType string
	}{
		{
			name:          "SubmitTransaction",
			indexed:       []interface{}{owner, big.NewInt(41), common.Address{}},
			nonIndexed:    []interface{}{largeValue, callData},
			removed:       true,
			wantIndex:     41,
			wantEventType: "submit",
		},
		{
			name:          "ConfirmTransaction",
			indexed:       []interface{}{owner, big.NewInt(42)},
			wantIndex:     42,
			wantEventType: "confirm",
		},
		{
			name:          "RevokeConfirmation",
			indexed:       []interface{}{owner, big.NewInt(43)},
			removed:       true,
			wantIndex:     43,
			wantEventType: "revoke",
		},
		{
			name:          "ExecuteTransaction",
			indexed:       []interface{}{owner, big.NewInt(44)},
			wantIndex:     44,
			wantEventType: "execute",
		},
	}

	decoder, err := NewEventDecoder(eventTestContractAddress)
	if err != nil {
		t.Fatalf("NewEventDecoder() = %v, want nil", err)
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw := buildEventTestLog(t, test.name, test.indexed, test.nonIndexed)
			raw.Removed = test.removed
			for i := range raw.Topics {
				raw.Topics[i] = strings.ToUpper(raw.Topics[i])
			}

			decoded, err := decoder.Decode(raw)
			if err != nil {
				t.Fatalf("Decode() = %v, want nil", err)
			}
			metadata := decoded.EventMetadata()
			if metadata.ContractAddress != strings.ToLower(eventTestContractAddress) {
				t.Errorf("ContractAddress = %q, want %q", metadata.ContractAddress, strings.ToLower(eventTestContractAddress))
			}
			if metadata.BlockNumber != 1234 || metadata.BlockHash != eventTestBlockHash || metadata.TransactionHash != eventTestTransactionHash {
				t.Errorf("chain metadata = %+v, want block 1234 and normalized hashes", metadata)
			}
			if metadata.TransactionIndex != 7 || metadata.LogIndex != 9 || metadata.Removed != test.removed {
				t.Errorf("position metadata = %+v, want tx index 7, log index 9, removed %t", metadata, test.removed)
			}

			switch got := decoded.(type) {
			case SubmitTransactionEvent:
				if test.wantEventType != "submit" {
					t.Fatalf("Decode() type = SubmitTransactionEvent, want %s", test.wantEventType)
				}
				if got.Owner != strings.ToLower(eventTestOwnerAddress) || got.MultisigTxIndex != test.wantIndex {
					t.Errorf("SubmitTransactionEvent identity = %+v", got)
				}
				if got.To != "0x0000000000000000000000000000000000000000" {
					t.Errorf("zero destination = %q, want canonical zero address", got.To)
				}
				if got.ValueWei == nil || got.ValueWei.Cmp(largeValue) != 0 || !bytes.Equal(got.Data, callData) {
					t.Errorf("SubmitTransactionEvent payload = value %v data %x", got.ValueWei, got.Data)
				}
			case ConfirmTransactionEvent:
				if test.wantEventType != "confirm" || got.Owner != strings.ToLower(eventTestOwnerAddress) || got.MultisigTxIndex != test.wantIndex {
					t.Errorf("ConfirmTransactionEvent = %+v, want index %d", got, test.wantIndex)
				}
			case RevokeConfirmationEvent:
				if test.wantEventType != "revoke" || got.Owner != strings.ToLower(eventTestOwnerAddress) || got.MultisigTxIndex != test.wantIndex {
					t.Errorf("RevokeConfirmationEvent = %+v, want index %d", got, test.wantIndex)
				}
			case ExecuteTransactionEvent:
				if test.wantEventType != "execute" || got.Owner != strings.ToLower(eventTestOwnerAddress) || got.MultisigTxIndex != test.wantIndex {
					t.Errorf("ExecuteTransactionEvent = %+v, want index %d", got, test.wantIndex)
				}
			default:
				t.Fatalf("Decode() type = %T, want a supported event", decoded)
			}
		})
	}
}

func TestEventDecoderCopiesSubmitTransactionData(t *testing.T) {
	callData := []byte{0x01, 0x02, 0x03}
	raw := buildEventTestLog(t, "SubmitTransaction",
		[]interface{}{common.HexToAddress(eventTestOwnerAddress), big.NewInt(1), common.HexToAddress("0x0000000000000000000000000000000000000001")},
		[]interface{}{big.NewInt(99), callData},
	)
	decoder, err := NewEventDecoder(eventTestContractAddress)
	if err != nil {
		t.Fatalf("NewEventDecoder() = %v, want nil", err)
	}

	decoded, err := decoder.Decode(raw)
	if err != nil {
		t.Fatalf("Decode() = %v, want nil", err)
	}
	got := decoded.(SubmitTransactionEvent)
	before := append([]byte(nil), got.Data...)
	for i := range raw.Data {
		raw.Data[i] ^= 0xff
	}
	if !bytes.Equal(got.Data, before) {
		t.Errorf("decoded event data changed after input mutation: got %x, want %x", got.Data, before)
	}
}

func TestEventDecoderRejectsZeroValueDecoder(t *testing.T) {
	if _, err := (&EventDecoder{}).Decode(validRawEventMetadata()); !errors.Is(err, ErrMalformedEvent) {
		t.Fatalf("Decode() on zero-value decoder error = %v, want ErrMalformedEvent", err)
	}
}

func TestEventDecoderReturnsUnsupportedEventForUnknownTopic0(t *testing.T) {
	raw := validRawEventMetadata()
	raw.Topics = []string{"0x" + strings.Repeat("f", 64)}
	decoder, err := NewEventDecoder(eventTestContractAddress)
	if err != nil {
		t.Fatalf("NewEventDecoder() = %v, want nil", err)
	}

	_, err = decoder.Decode(raw)
	if !errors.Is(err, ErrUnsupportedEvent) {
		t.Fatalf("Decode(unknown topic0) error = %v, want ErrUnsupportedEvent", err)
	}
}

func TestEventDecoderRejectsMalformedEvents(t *testing.T) {
	validConfirm := func() RawLog {
		return buildEventTestLog(t, "ConfirmTransaction",
			[]interface{}{common.HexToAddress(eventTestOwnerAddress), big.NewInt(1)}, nil)
	}
	validSubmit := func() RawLog {
		return buildEventTestLog(t, "SubmitTransaction",
			[]interface{}{common.HexToAddress(eventTestOwnerAddress), big.NewInt(1), common.HexToAddress(eventTestContractAddress)},
			[]interface{}{big.NewInt(1), []byte{0xaa}},
		)
	}

	tests := []struct {
		name string
		raw  RawLog
	}{
		{name: "no topics", raw: func() RawLog { raw := validConfirm(); raw.Topics = nil; return raw }()},
		{name: "malformed topic hash", raw: func() RawLog { raw := validConfirm(); raw.Topics[1] = "0x1234"; return raw }()},
		{name: "indexed topic count", raw: func() RawLog { raw := validConfirm(); raw.Topics = raw.Topics[:2]; return raw }()},
		{name: "non-canonical indexed address padding", raw: func() RawLog {
			raw := validConfirm()
			var topic common.Hash
			topic[11] = 1
			copy(topic[common.HashLength-common.AddressLength:], common.HexToAddress(eventTestOwnerAddress).Bytes())
			raw.Topics[1] = topic.Hex()
			return raw
		}()},
		{name: "truncated event data", raw: func() RawLog { raw := validSubmit(); raw.Data = []byte{0x01}; return raw }()},
		{name: "trailing event data", raw: func() RawLog { raw := validConfirm(); raw.Data = []byte{0x01}; return raw }()},
		{name: "invalid block hash", raw: func() RawLog { raw := validConfirm(); raw.BlockHash = "bad"; return raw }()},
		{name: "invalid transaction hash", raw: func() RawLog { raw := validConfirm(); raw.TransactionHash = "bad"; return raw }()},
		{name: "zero owner", raw: func() RawLog {
			raw := validConfirm()
			raw.Topics[1] = common.BytesToHash(make([]byte, common.AddressLength)).Hex()
			return raw
		}()},
	}

	decoder, err := NewEventDecoder(eventTestContractAddress)
	if err != nil {
		t.Fatalf("NewEventDecoder() = %v, want nil", err)
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decoder.Decode(test.raw); !errors.Is(err, ErrMalformedEvent) {
				t.Fatalf("Decode() error = %v, want ErrMalformedEvent", err)
			}
		})
	}
}

func TestEventDecoderRejectsWrongEmitterAndOverflow(t *testing.T) {
	decoder, err := NewEventDecoder(eventTestContractAddress)
	if err != nil {
		t.Fatalf("NewEventDecoder() = %v, want nil", err)
	}

	wrongEmitter := buildEventTestLog(t, "ConfirmTransaction",
		[]interface{}{common.HexToAddress(eventTestOwnerAddress), big.NewInt(1)}, nil)
	wrongEmitter.Address = "0x0000000000000000000000000000000000000001"
	if _, err := decoder.Decode(wrongEmitter); !errors.Is(err, ErrUnexpectedContract) {
		t.Fatalf("Decode(wrong emitter) error = %v, want ErrUnexpectedContract", err)
	}

	overflow := new(big.Int).Lsh(big.NewInt(1), 64)
	overflowLog := buildEventTestLog(t, "ConfirmTransaction",
		[]interface{}{common.HexToAddress(eventTestOwnerAddress), overflow}, nil)
	if _, err := decoder.Decode(overflowLog); !errors.Is(err, ErrMalformedEvent) {
		t.Fatalf("Decode(overflow index) error = %v, want ErrMalformedEvent", err)
	}
}

func TestEventDecoderRejectsMalformedMetadata(t *testing.T) {
	decoder, err := NewEventDecoder(eventTestContractAddress)
	if err != nil {
		t.Fatalf("NewEventDecoder() = %v, want nil", err)
	}
	raw := buildEventTestLog(t, "ConfirmTransaction",
		[]interface{}{common.HexToAddress(eventTestOwnerAddress), big.NewInt(1)}, nil)
	raw.Address = "not-an-address"
	if _, err := decoder.Decode(raw); !errors.Is(err, ErrMalformedEvent) {
		t.Fatalf("Decode(invalid emitter) error = %v, want ErrMalformedEvent", err)
	}
}

func buildEventTestLog(t *testing.T, name string, indexedValues, nonIndexedValues []interface{}) RawLog {
	t.Helper()
	contractABI, err := abi.JSON(strings.NewReader(multiSigEventABI))
	if err != nil {
		t.Fatalf("parse event test ABI: %v", err)
	}
	event, ok := contractABI.Events[name]
	if !ok {
		t.Fatalf("test ABI does not contain event %q", name)
	}
	if len(indexedValues) != len(indexedArguments(event.Inputs)) {
		t.Fatalf("%s test indexed values = %d, want %d", name, len(indexedValues), len(indexedArguments(event.Inputs)))
	}
	if len(nonIndexedValues) != len(event.Inputs.NonIndexed()) {
		t.Fatalf("%s test non-indexed values = %d, want %d", name, len(nonIndexedValues), len(event.Inputs.NonIndexed()))
	}

	indexedTopics, err := abi.MakeTopics(indexedValues)
	if err != nil {
		t.Fatalf("encode %s indexed values: %v", name, err)
	}
	if len(indexedTopics) != 1 {
		t.Fatalf("MakeTopics() returned %d topic groups, want one", len(indexedTopics))
	}
	topics := []string{event.ID.Hex()}
	for _, topic := range indexedTopics[0] {
		topics = append(topics, topic.Hex())
	}
	data, err := event.Inputs.NonIndexed().Pack(nonIndexedValues...)
	if err != nil {
		t.Fatalf("encode %s non-indexed values: %v", name, err)
	}
	return RawLog{
		Address:          strings.ToUpper(eventTestContractAddress),
		Topics:           topics,
		Data:             data,
		BlockNumber:      1234,
		BlockHash:        strings.ToUpper(eventTestBlockHash),
		TransactionHash:  strings.ToUpper(eventTestTransactionHash),
		TransactionIndex: 7,
		LogIndex:         9,
	}
}

func validRawEventMetadata() RawLog {
	return RawLog{
		Address:          eventTestContractAddress,
		BlockNumber:      1234,
		BlockHash:        eventTestBlockHash,
		TransactionHash:  eventTestTransactionHash,
		TransactionIndex: 7,
		LogIndex:         9,
	}
}
