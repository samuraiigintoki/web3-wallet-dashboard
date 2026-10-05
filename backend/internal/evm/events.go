package evm

import (
	"bytes"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

var (
	// ErrUnsupportedEvent means topic0 is a valid hash but does not identify
	// one of the four MultiSigWallet events handled by this decoder.
	ErrUnsupportedEvent = errors.New("unsupported EVM event")
	// ErrMalformedEvent means a raw log has invalid metadata, topics, or data.
	ErrMalformedEvent = errors.New("malformed EVM event")
	// ErrUnexpectedContract means a raw log was emitted by an address other
	// than the contract configured for this decoder.
	ErrUnexpectedContract = errors.New("unexpected event contract address")
)

// RawLog is the plain-Go input to EventDecoder. Its fields correspond to the
// metadata needed from an EVM log without exposing go-ethereum types.
type RawLog struct {
	Address          string
	Topics           []string
	Data             []byte
	BlockNumber      uint64
	BlockHash        string
	TransactionHash  string
	TransactionIndex uint64
	LogIndex         uint64
	Removed          bool
}

// EventMetadata contains the common, normalized metadata for a decoded log.
type EventMetadata struct {
	ContractAddress  string
	BlockNumber      uint64
	BlockHash        string
	TransactionHash  string
	TransactionIndex uint64
	LogIndex         uint64
	Removed          bool
}

// DecodedEvent is implemented by each supported MultiSigWallet event type.
type DecodedEvent interface {
	EventMetadata() EventMetadata
}

// SubmitTransactionEvent is emitted when an owner submits a multisig
// transaction. MultisigTxIndex is the contract's index, while
// Metadata.TransactionIndex is the transaction's position in its block.
type SubmitTransactionEvent struct {
	Metadata        EventMetadata
	Owner           string
	MultisigTxIndex uint64
	To              string
	ValueWei        *big.Int
	Data            []byte
}

func (e SubmitTransactionEvent) EventMetadata() EventMetadata { return e.Metadata }

// ConfirmTransactionEvent is emitted when an owner confirms a multisig
// transaction.
type ConfirmTransactionEvent struct {
	Metadata        EventMetadata
	Owner           string
	MultisigTxIndex uint64
}

func (e ConfirmTransactionEvent) EventMetadata() EventMetadata { return e.Metadata }

// RevokeConfirmationEvent is emitted when an owner revokes a confirmation.
type RevokeConfirmationEvent struct {
	Metadata        EventMetadata
	Owner           string
	MultisigTxIndex uint64
}

func (e RevokeConfirmationEvent) EventMetadata() EventMetadata { return e.Metadata }

// ExecuteTransactionEvent is emitted when a multisig transaction is executed.
type ExecuteTransactionEvent struct {
	Metadata        EventMetadata
	Owner           string
	MultisigTxIndex uint64
}

func (e ExecuteTransactionEvent) EventMetadata() EventMetadata { return e.Metadata }

// EventDecoder decodes only the four existing MultiSigWallet events. It does
// not retrieve logs or interpret the Removed flag.
type EventDecoder struct {
	contractAddress string
	events          map[common.Hash]abi.Event
}

const multiSigEventABI = `[
  {"type":"event","name":"SubmitTransaction","anonymous":false,"inputs":[
    {"name":"owner","type":"address","indexed":true},
    {"name":"txIndex","type":"uint256","indexed":true},
    {"name":"to","type":"address","indexed":true},
    {"name":"value","type":"uint256","indexed":false},
    {"name":"data","type":"bytes","indexed":false}
  ]},
  {"type":"event","name":"ConfirmTransaction","anonymous":false,"inputs":[
    {"name":"owner","type":"address","indexed":true},
    {"name":"txIndex","type":"uint256","indexed":true}
  ]},
  {"type":"event","name":"RevokeConfirmation","anonymous":false,"inputs":[
    {"name":"owner","type":"address","indexed":true},
    {"name":"txIndex","type":"uint256","indexed":true}
  ]},
  {"type":"event","name":"ExecuteTransaction","anonymous":false,"inputs":[
    {"name":"owner","type":"address","indexed":true},
    {"name":"txIndex","type":"uint256","indexed":true}
  ]}
]`

// supportedEventTopics holds the topic0 hash of each supported event, in the
// same order as multiSigEventNames. The hashes are derived from the embedded
// event ABI, so they cannot drift from the decoder. A failure here means the
// compiled-in ABI is itself invalid, which no caller could handle at runtime.
var supportedEventTopics = mustSupportedEventTopics()

func mustSupportedEventTopics() []string {
	contractABI, err := abi.JSON(strings.NewReader(multiSigEventABI))
	if err != nil {
		panic(fmt.Sprintf("evm: parse embedded event ABI for topics: %v", err))
	}
	topics := make([]string, 0, len(multiSigEventNames))
	for _, name := range multiSigEventNames {
		event, ok := contractABI.Events[name]
		if !ok {
			panic(fmt.Sprintf("evm: embedded event ABI is missing %s", name))
		}
		topics = append(topics, strings.ToLower(event.ID.Hex()))
	}
	return topics
}

var multiSigEventNames = [...]string{
	"SubmitTransaction",
	"ConfirmTransaction",
	"RevokeConfirmation",
	"ExecuteTransaction",
}

// NewEventDecoder builds a decoder for the configured, non-zero contract
// address. The embedded ABI contains only the four supported event schemas.
func NewEventDecoder(expectedContractAddress string) (*EventDecoder, error) {
	contractAddress, err := normalizeAddress(expectedContractAddress, true)
	if err != nil {
		return nil, fmt.Errorf("evm: event decoder contract address: %w", err)
	}

	contractABI, err := abi.JSON(strings.NewReader(multiSigEventABI))
	if err != nil {
		return nil, fmt.Errorf("evm: parse multisig event ABI: %w", err)
	}
	events := make(map[common.Hash]abi.Event, len(multiSigEventNames))
	for _, name := range multiSigEventNames {
		event, ok := contractABI.Events[name]
		if !ok {
			return nil, fmt.Errorf("evm: multisig event ABI is missing %s", name)
		}
		events[event.ID] = event
	}

	return &EventDecoder{contractAddress: contractAddress, events: events}, nil
}

// Decode validates and decodes one raw log. Addresses and hashes in the
// returned event are lowercase, 0x-prefixed strings. Removed is preserved as
// metadata but is not interpreted here.
func (d *EventDecoder) Decode(raw RawLog) (DecodedEvent, error) {
	if d == nil || d.events == nil || d.contractAddress == "" {
		return nil, malformedEvent("decoder is not initialized")
	}

	address, err := normalizeAddress(raw.Address, false)
	if err != nil {
		return nil, malformedEvent("invalid emitter address: %v", err)
	}
	if address != d.contractAddress {
		return nil, fmt.Errorf("%w: got %s, want %s", ErrUnexpectedContract, address, d.contractAddress)
	}
	if len(raw.Topics) == 0 {
		return nil, malformedEvent("no topics")
	}

	topics := make([]common.Hash, len(raw.Topics))
	for i, topic := range raw.Topics {
		normalized, normalizeErr := normalizeHash(topic)
		if normalizeErr != nil {
			return nil, malformedEvent("topic %d: %v", i, normalizeErr)
		}
		topics[i] = common.HexToHash(normalized)
	}

	blockHash, err := normalizeHash(raw.BlockHash)
	if err != nil {
		return nil, malformedEvent("block hash: %v", err)
	}
	transactionHash, err := normalizeHash(raw.TransactionHash)
	if err != nil {
		return nil, malformedEvent("transaction hash: %v", err)
	}

	event, ok := d.events[topics[0]]
	if !ok {
		return nil, fmt.Errorf("%w: topic0 %s", ErrUnsupportedEvent, topics[0].Hex())
	}

	indexed := indexedArguments(event.Inputs)
	if len(topics) != len(indexed)+1 {
		return nil, malformedEvent("%s has %d indexed topics, got %d", event.Name, len(indexed), len(topics)-1)
	}
	indexedValues := make(map[string]interface{}, len(indexed))
	if err := abi.ParseTopicsIntoMap(indexedValues, indexed, topics[1:]); err != nil {
		return nil, malformedEvent("%s indexed topics: %v", event.Name, err)
	}
	if err := validateIndexedTopicEncoding(indexed, indexedValues, topics[1:]); err != nil {
		return nil, malformedEvent("%s indexed topics: %v", event.Name, err)
	}

	nonIndexed := event.Inputs.NonIndexed()
	dataValues, err := nonIndexed.Unpack(raw.Data)
	if err != nil {
		return nil, malformedEvent("%s data: %v", event.Name, err)
	}
	canonicalData, err := nonIndexed.Pack(dataValues...)
	if err != nil {
		return nil, malformedEvent("%s data cannot be re-encoded: %v", event.Name, err)
	}
	if !bytes.Equal(canonicalData, raw.Data) {
		return nil, malformedEvent("%s data is not a canonical ABI encoding", event.Name)
	}

	metadata := EventMetadata{
		ContractAddress:  address,
		BlockNumber:      raw.BlockNumber,
		BlockHash:        blockHash,
		TransactionHash:  transactionHash,
		TransactionIndex: raw.TransactionIndex,
		LogIndex:         raw.LogIndex,
		Removed:          raw.Removed,
	}
	return decodeMultiSigEvent(event.Name, indexedValues, dataValues, metadata)
}

func indexedArguments(arguments abi.Arguments) abi.Arguments {
	var indexed abi.Arguments
	for _, argument := range arguments {
		if argument.Indexed {
			indexed = append(indexed, argument)
		}
	}
	return indexed
}

func validateIndexedTopicEncoding(fields abi.Arguments, values map[string]interface{}, topics []common.Hash) error {
	for i, field := range fields {
		switch field.Type.T {
		case abi.AddressTy:
			address, ok := values[field.Name].(common.Address)
			if !ok {
				return fmt.Errorf("indexed field %q is not an address", field.Name)
			}
			var canonical common.Hash
			copy(canonical[common.HashLength-common.AddressLength:], address[:])
			if canonical != topics[i] {
				return fmt.Errorf("indexed address %q has non-zero padding", field.Name)
			}
		case abi.UintTy:
			value, ok := values[field.Name].(*big.Int)
			if !ok || value == nil || value.Sign() < 0 {
				return fmt.Errorf("indexed field %q is not an unsigned integer", field.Name)
			}
			if value.BitLen() > field.Type.Size {
				return fmt.Errorf("indexed integer %q exceeds %d bits", field.Name, field.Type.Size)
			}
			if common.BigToHash(value) != topics[i] {
				return fmt.Errorf("indexed integer %q is not canonically encoded", field.Name)
			}
		default:
			return fmt.Errorf("indexed field %q has an unsupported ABI type", field.Name)
		}
	}
	return nil
}

func decodeMultiSigEvent(name string, indexed map[string]interface{}, data []interface{}, metadata EventMetadata) (DecodedEvent, error) {
	owner, err := decodeEventAddress(indexed, "owner", true)
	if err != nil {
		return nil, malformedEvent("%s owner: %v", name, err)
	}
	transactionIndex, err := decodeEventIndex(indexed)
	if err != nil {
		return nil, malformedEvent("%s transaction index: %v", name, err)
	}

	switch name {
	case "SubmitTransaction":
		to, err := decodeEventAddress(indexed, "to", false)
		if err != nil {
			return nil, malformedEvent("SubmitTransaction destination: %v", err)
		}
		if len(data) != 2 {
			return nil, malformedEvent("SubmitTransaction has %d non-indexed values, want 2", len(data))
		}
		value, ok := data[0].(*big.Int)
		if !ok || value == nil || value.Sign() < 0 || value.BitLen() > 256 {
			return nil, malformedEvent("SubmitTransaction value is not uint256")
		}
		callData, ok := data[1].([]byte)
		if !ok {
			return nil, malformedEvent("SubmitTransaction data is not bytes")
		}
		return SubmitTransactionEvent{
			Metadata:        metadata,
			Owner:           owner,
			MultisigTxIndex: transactionIndex,
			To:              to,
			ValueWei:        new(big.Int).Set(value),
			Data:            append([]byte(nil), callData...),
		}, nil
	case "ConfirmTransaction":
		if len(data) != 0 {
			return nil, malformedEvent("ConfirmTransaction has unexpected non-indexed values")
		}
		return ConfirmTransactionEvent{Metadata: metadata, Owner: owner, MultisigTxIndex: transactionIndex}, nil
	case "RevokeConfirmation":
		if len(data) != 0 {
			return nil, malformedEvent("RevokeConfirmation has unexpected non-indexed values")
		}
		return RevokeConfirmationEvent{Metadata: metadata, Owner: owner, MultisigTxIndex: transactionIndex}, nil
	case "ExecuteTransaction":
		if len(data) != 0 {
			return nil, malformedEvent("ExecuteTransaction has unexpected non-indexed values")
		}
		return ExecuteTransactionEvent{Metadata: metadata, Owner: owner, MultisigTxIndex: transactionIndex}, nil
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedEvent, name)
	}
}

func decodeEventAddress(values map[string]interface{}, name string, rejectZero bool) (string, error) {
	value, ok := values[name].(common.Address)
	if !ok {
		return "", fmt.Errorf("indexed field %q is not an address", name)
	}
	address, err := normalizeAddress(value.Hex(), rejectZero)
	if err != nil {
		return "", err
	}
	return address, nil
}

func decodeEventIndex(values map[string]interface{}) (uint64, error) {
	value, ok := values["txIndex"].(*big.Int)
	if !ok || value == nil || value.Sign() < 0 {
		return 0, errors.New("indexed field txIndex is not uint256")
	}
	if !value.IsUint64() {
		return 0, fmt.Errorf("indexed field txIndex value %s overflows uint64", value)
	}
	return value.Uint64(), nil
}

func malformedEvent(format string, args ...interface{}) error {
	return fmt.Errorf("%w: %s", ErrMalformedEvent, fmt.Sprintf(format, args...))
}
