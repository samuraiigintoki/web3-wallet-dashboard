package evm

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// LogFilter describes one read-only eth_getLogs request: an inclusive block
// range, one contract address and the event topics to keep. Topics are the
// positional filter of the JSON-RPC method, and this package only ever needs
// the first position, so at most one group is accepted.
type LogFilter struct {
	FromBlock uint64
	ToBlock   uint64
	Address   string
	Topics    [][]string
}

// NewLogFilter builds a filter for one contract over an inclusive block range
// with the four supported event topics in canonical order.
func NewLogFilter(fromBlock, toBlock uint64, address string) LogFilter {
	return LogFilter{
		FromBlock: fromBlock,
		ToBlock:   toBlock,
		Address:   address,
		Topics:    [][]string{SupportedEventTopics()},
	}
}

// SupportedEventTopics returns the topic0 hashes of the four indexed
// MultiSigWallet events, in the same canonical order the decoder uses. The
// hashes come from the embedded event ABI, so they cannot drift from it.
func SupportedEventTopics() []string {
	topics := make([]string, 0, len(supportedEventTopics))
	for _, topic := range supportedEventTopics {
		topics = append(topics, topic)
	}
	return topics
}

func isSupportedEventTopic(topic string) bool {
	for _, supported := range supportedEventTopics {
		if topic == supported {
			return true
		}
	}
	return false
}

// FilterLogs reads the logs one filter matches. It performs exactly one
// eth_getLogs call with the caller's context and does not retry. Returned logs
// are plain Go values in the order the endpoint sent them, which this layer
// does not reorder.
func (c *Client) FilterLogs(ctx context.Context, filter LogFilter) ([]RawLog, error) {
	if c == nil || c.reader == nil {
		return nil, errors.New("evm: chain reader is nil")
	}

	normalized, err := normalizeLogFilter(filter)
	if err != nil {
		return nil, err
	}

	logs, err := c.reader.FilterLogs(ctx, normalized)
	if err != nil {
		return nil, fmt.Errorf("evm: read logs for %s over %d..%d: %w", normalized.Address, normalized.FromBlock, normalized.ToBlock, err)
	}

	for i, raw := range logs {
		if err := checkReturnedLog(raw, normalized); err != nil {
			return nil, fmt.Errorf("evm: log %d: %w", i, err)
		}
	}
	return logs, nil
}

// normalizeLogFilter validates the caller's filter and canonicalizes it. The
// address and every topic are lowercased so the wire request is deterministic,
// and topics are reordered into the supported order.
func normalizeLogFilter(filter LogFilter) (LogFilter, error) {
	address, err := normalizeAddress(filter.Address, true)
	if err != nil {
		return LogFilter{}, fmt.Errorf("evm: log filter address: %w", err)
	}
	if filter.FromBlock > filter.ToBlock {
		return LogFilter{}, fmt.Errorf("evm: log filter range %d..%d is inverted", filter.FromBlock, filter.ToBlock)
	}
	if len(filter.Topics) > 1 {
		return LogFilter{}, fmt.Errorf("evm: log filter has %d topic positions, at most one is supported", len(filter.Topics))
	}

	requested := make(map[string]struct{})
	if len(filter.Topics) == 1 {
		for i, topic := range filter.Topics[0] {
			normalized, err := normalizeHash(topic)
			if err != nil {
				return LogFilter{}, fmt.Errorf("evm: log filter topic %d: %w", i, err)
			}
			if !isSupportedEventTopic(normalized) {
				return LogFilter{}, fmt.Errorf("evm: log filter topic %d is not a supported event topic", i)
			}
			if _, duplicate := requested[normalized]; duplicate {
				return LogFilter{}, fmt.Errorf("evm: log filter repeats supported event topic %d", i)
			}
			requested[normalized] = struct{}{}
		}
	}

	// An empty topic list means every supported event, which is what the scanner
	// wants. A subset is allowed, so a drill can read one event type, but an
	// unknown topic can never reach the endpoint.
	var topics [][]string
	if len(requested) == 0 {
		topics = [][]string{SupportedEventTopics()}
	} else {
		canonical := make([]string, 0, len(requested))
		for _, supported := range supportedEventTopics {
			if _, ok := requested[supported]; ok {
				canonical = append(canonical, supported)
			}
		}
		topics = [][]string{canonical}
	}

	return LogFilter{
		FromBlock: filter.FromBlock,
		ToBlock:   filter.ToBlock,
		Address:   address,
		Topics:    topics,
	}, nil
}

// checkReturnedLog rejects a log the endpoint should not have returned: a
// different emitter or a block outside the requested window. Those are filter
// or node faults, not data to hand to the scanner.
func checkReturnedLog(raw RawLog, filter LogFilter) error {
	address, err := normalizeAddress(raw.Address, true)
	if err != nil {
		return fmt.Errorf("returned log address: %w", err)
	}
	if address != filter.Address {
		return fmt.Errorf("returned log address %s is not the filtered address %s", address, filter.Address)
	}
	if raw.BlockNumber < filter.FromBlock || raw.BlockNumber > filter.ToBlock {
		return fmt.Errorf("returned log block %d is outside the requested range %d..%d", raw.BlockNumber, filter.FromBlock, filter.ToBlock)
	}
	if !isZeroHash(raw.BlockHash) {
		return nil
	}
	return errors.New("returned log has a zero block hash")
}

// FilterLogs adapts the plain-Go boundary to ethclient.FilterLogs. go-ethereum
// log types do not escape this adapter.
func (r ethclientReader) FilterLogs(ctx context.Context, filter LogFilter) ([]RawLog, error) {
	if r.c == nil {
		return nil, errors.New("ethclient reader is nil")
	}
	normalized, err := normalizeLogFilter(filter)
	if err != nil {
		return nil, err
	}

	query, err := logQueryForFilter(normalized)
	if err != nil {
		return nil, err
	}
	logs, err := r.c.FilterLogs(ctx, query)
	if err != nil {
		return nil, err
	}

	raw := make([]RawLog, 0, len(logs))
	for i, log := range logs {
		converted, err := rawLogFromGeth(log)
		if err != nil {
			return nil, fmt.Errorf("log %d: %w", i, err)
		}
		raw = append(raw, converted)
	}
	return raw, nil
}

// logQueryForFilter builds the go-ethereum filter the adapter sends. The topic
// groups become positional topic filters, so this is where a supported topic
// list turns into a wire request. The query type is local to the adapter.
func logQueryForFilter(filter LogFilter) (ethereum.FilterQuery, error) {
	query := ethereum.FilterQuery{
		FromBlock: new(big.Int).SetUint64(filter.FromBlock),
		ToBlock:   new(big.Int).SetUint64(filter.ToBlock),
	}
	if !common.IsHexAddress(filter.Address) {
		return ethereum.FilterQuery{}, fmt.Errorf("invalid filter address %q", filter.Address)
	}
	query.Addresses = []common.Address{common.HexToAddress(filter.Address)}

	for i, group := range filter.Topics {
		if len(group) == 0 {
			return ethereum.FilterQuery{}, fmt.Errorf("topic position %d is empty", i)
		}
		topics := make([]common.Hash, 0, len(group))
		for j, topic := range group {
			normalized, err := normalizeHash(topic)
			if err != nil {
				return ethereum.FilterQuery{}, fmt.Errorf("topic %d in position %d: %w", j, i, err)
			}
			topics = append(topics, common.HexToHash(normalized))
		}
		query.Topics = append(query.Topics, topics)
	}
	return query, nil
}

// rawLogFromGeth converts one go-ethereum log into the plain Go type the
// decoder already consumes. Removed is preserved as metadata and is not
// interpreted here.
func rawLogFromGeth(log types.Log) (RawLog, error) {
	if !common.IsHexAddress(log.Address.Hex()) {
		return RawLog{}, errors.New("log has a malformed address")
	}
	address := strings.ToLower(log.Address.Hex())
	if isZeroAddress(address) {
		return RawLog{}, errors.New("log has a zero address")
	}

	topics := make([]string, 0, len(log.Topics))
	for i, topic := range log.Topics {
		hash := strings.ToLower(topic.Hex())
		if isZeroHash(hash) {
			return RawLog{}, fmt.Errorf("log topic %d is zero", i)
		}
		topics = append(topics, hash)
	}
	if len(topics) == 0 {
		return RawLog{}, errors.New("log has no topics")
	}

	blockHash := strings.ToLower(log.BlockHash.Hex())
	if isZeroHash(blockHash) {
		return RawLog{}, errors.New("log has a zero block hash")
	}
	transactionHash := strings.ToLower(log.TxHash.Hex())
	if isZeroHash(transactionHash) {
		return RawLog{}, errors.New("log has a zero transaction hash")
	}

	return RawLog{
		Address:          address,
		Topics:           topics,
		Data:             append([]byte(nil), log.Data...),
		BlockNumber:      log.BlockNumber,
		BlockHash:        blockHash,
		TransactionHash:  transactionHash,
		TransactionIndex: uint64(log.TxIndex),
		LogIndex:         uint64(log.Index),
		Removed:          log.Removed,
	}, nil
}
