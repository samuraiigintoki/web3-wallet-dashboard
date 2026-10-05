package evm

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

const (
	// logTestAddress is the lowercase canonical form of the fixture contract, the
	// representation this package stores and returns.
	logTestAddress = "0x5b324f41e5889cf94cba8e909089683a1a97c318"
	// logTestChecksummedAddress is the same address as an operator would paste it.
	logTestChecksummedAddress = "0x5B324F41E5889cf94CbA8e909089683a1a97c318"
	logTestOtherAddress       = "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746"
)

func gethLog(blockNumber uint64, address string, topics ...string) types.Log {
	parsed := make([]common.Hash, 0, len(topics))
	for _, topic := range topics {
		parsed = append(parsed, common.HexToHash(topic))
	}
	return types.Log{
		Address:     common.HexToAddress(address),
		Topics:      parsed,
		Data:        []byte{0xde, 0xad},
		BlockNumber: blockNumber,
		BlockHash:   common.HexToHash("0x" + strings.Repeat("11", 32)),
		TxHash:      common.HexToHash("0x" + strings.Repeat("22", 32)),
		TxIndex:     3,
		Index:       7,
		Removed:     true,
	}
}

// TestSupportedEventTopicsMatchABI pins the topic list to the embedded ABI,
// so the filter and the decoder can never disagree about the four events.
func TestSupportedEventTopicsMatchABI(t *testing.T) {
	decoder, err := NewEventDecoder(multisigFixtureAddress)
	if err != nil {
		t.Fatalf("NewEventDecoder() = %v, want nil", err)
	}

	topics := SupportedEventTopics()
	if len(topics) != len(multiSigEventNames) {
		t.Fatalf("SupportedEventTopics() returned %d topics, want %d", len(topics), len(multiSigEventNames))
	}

	seen := make(map[string]struct{}, len(topics))
	for i, topic := range topics {
		if !strings.HasPrefix(topic, "0x") || len(topic) != 66 || topic != strings.ToLower(topic) {
			t.Errorf("topic %d = %q, want a lowercase 0x-prefixed 32-byte hash", i, topic)
		}
		if _, duplicate := seen[topic]; duplicate {
			t.Errorf("topic %d = %q is a duplicate", i, topic)
		}
		seen[topic] = struct{}{}
		if _, ok := decoder.events[common.HexToHash(topic)]; !ok {
			t.Errorf("topic %d = %q is not a hash the decoder knows", i, topic)
		}
	}

	// The order is the decoder's order, so a filter built from this list is
	// deterministic across calls.
	if topics[0] != strings.ToLower(decoder.events[common.HexToHash(topics[0])].ID.Hex()) {
		t.Error("topic 0 does not match the decoder event ID")
	}

	// A returned slice is a copy: mutating it must not change the package list.
	topics[0] = "0x" + strings.Repeat("00", 32)
	if SupportedEventTopics()[0] == topics[0] {
		t.Error("SupportedEventTopics() exposed the package slice")
	}
}

func TestNewLogFilter(t *testing.T) {
	filter := NewLogFilter(100, 199, logTestAddress)

	if filter.FromBlock != 100 || filter.ToBlock != 199 {
		t.Errorf("range = %d..%d, want 100..199", filter.FromBlock, filter.ToBlock)
	}
	if filter.Address != logTestAddress {
		t.Errorf("address = %q, want %q", filter.Address, logTestAddress)
	}
	if len(filter.Topics) != 1 {
		t.Fatalf("topic positions = %d, want 1", len(filter.Topics))
	}
	if !slices.Equal(filter.Topics[0], SupportedEventTopics()) {
		t.Errorf("topics = %v, want the four supported topics", filter.Topics[0])
	}
}

func TestNormalizeLogFilter(t *testing.T) {
	supported := SupportedEventTopics()

	t.Run("normalizes the address and canonicalizes topics", func(t *testing.T) {
		// A reversed subset must come back in the supported order.
		filter := LogFilter{
			FromBlock: 0,
			ToBlock:   0,
			Address:   logTestChecksummedAddress,
			Topics:    [][]string{{supported[3], supported[1]}},
		}

		got, err := normalizeLogFilter(filter)
		if err != nil {
			t.Fatalf("normalizeLogFilter() = %v, want nil", err)
		}
		if got.Address != logTestAddress {
			t.Errorf("address = %q, want %q", got.Address, logTestAddress)
		}
		if !slices.Equal(got.Topics[0], []string{supported[1], supported[3]}) {
			t.Errorf("topics = %v, want the supported order %v", got.Topics[0], []string{supported[1], supported[3]})
		}
		if got.FromBlock != 0 || got.ToBlock != 0 {
			t.Errorf("range = %d..%d, want the single block 0", got.FromBlock, got.ToBlock)
		}
	})

	t.Run("an empty topic list means every supported event", func(t *testing.T) {
		got, err := normalizeLogFilter(LogFilter{FromBlock: 5, ToBlock: 6, Address: logTestAddress})
		if err != nil {
			t.Fatalf("normalizeLogFilter() = %v, want nil", err)
		}
		if !slices.Equal(got.Topics[0], supported) {
			t.Errorf("topics = %v, want the full supported set", got.Topics[0])
		}
	})

	t.Run("accepts a single supported topic", func(t *testing.T) {
		got, err := normalizeLogFilter(LogFilter{
			FromBlock: 1, ToBlock: 2, Address: logTestAddress,
			Topics: [][]string{{supported[2]}},
		})
		if err != nil {
			t.Fatalf("normalizeLogFilter() = %v, want nil", err)
		}
		if !slices.Equal(got.Topics[0], []string{supported[2]}) {
			t.Errorf("topics = %v, want [%s]", got.Topics[0], supported[2])
		}
	})

	t.Run("rejects invalid filters", func(t *testing.T) {
		unknownTopic := "0x" + strings.Repeat("99", 32)
		cases := map[string]struct {
			filter LogFilter
			want   string
		}{
			"inverted range": {
				filter: LogFilter{FromBlock: 10, ToBlock: 9, Address: logTestAddress},
				want:   "inverted",
			},
			"zero address": {
				filter: LogFilter{FromBlock: 1, ToBlock: 2, Address: "0x" + strings.Repeat("0", 40)},
				want:   "zero address",
			},
			"malformed address": {
				filter: LogFilter{FromBlock: 1, ToBlock: 2, Address: "0x1234"},
				want:   "log filter address",
			},
			"two topic positions": {
				filter: LogFilter{FromBlock: 1, ToBlock: 2, Address: logTestAddress, Topics: [][]string{{supported[0]}, {supported[1]}}},
				want:   "at most one is supported",
			},
			"unknown topic": {
				filter: LogFilter{FromBlock: 1, ToBlock: 2, Address: logTestAddress, Topics: [][]string{{unknownTopic}}},
				want:   "not a supported event topic",
			},
			"malformed topic": {
				filter: LogFilter{FromBlock: 1, ToBlock: 2, Address: logTestAddress, Topics: [][]string{{"0x1234"}}},
				want:   "log filter topic",
			},
			"duplicate topic": {
				filter: LogFilter{FromBlock: 1, ToBlock: 2, Address: logTestAddress, Topics: [][]string{{supported[0], supported[0]}}},
				want:   "repeats supported event topic",
			},
		}
		for name, tt := range cases {
			t.Run(name, func(t *testing.T) {
				if _, err := normalizeLogFilter(tt.filter); err == nil {
					t.Fatal("normalizeLogFilter() = nil, want an error")
				} else if !strings.Contains(err.Error(), tt.want) {
					t.Errorf("error %q does not mention %q", err, tt.want)
				}
			})
		}
	})
}

func TestCheckReturnedLog(t *testing.T) {
	supported := SupportedEventTopics()
	filter := NewLogFilter(100, 199, logTestAddress)
	normalized, err := normalizeLogFilter(filter)
	if err != nil {
		t.Fatalf("normalizeLogFilter() = %v, want nil", err)
	}

	valid := RawLog{
		Address:          logTestAddress,
		Topics:           []string{supported[0]},
		BlockNumber:      150,
		BlockHash:        "0x" + strings.Repeat("11", 32),
		TransactionHash:  "0x" + strings.Repeat("22", 32),
		TransactionIndex: 1,
		LogIndex:         2,
	}
	if err := checkReturnedLog(valid, normalized); err != nil {
		t.Fatalf("checkReturnedLog(valid) = %v, want nil", err)
	}

	// Both range ends are inclusive.
	atStart := valid
	atStart.BlockNumber = 100
	if err := checkReturnedLog(atStart, normalized); err != nil {
		t.Errorf("log at the range start = %v, want nil", err)
	}
	atEnd := valid
	atEnd.BlockNumber = 199
	if err := checkReturnedLog(atEnd, normalized); err != nil {
		t.Errorf("log at the range end = %v, want nil", err)
	}

	cases := map[string]struct {
		log  RawLog
		want string
	}{
		"other address":     {log: withLogAddress(valid, logTestOtherAddress), want: "is not the filtered address"},
		"above the range":   {log: withLogBlock(valid, 200), want: "outside the requested range"},
		"below the range":   {log: withLogBlock(valid, 99), want: "outside the requested range"},
		"zero block hash":   {log: withLogBlockHash(valid, "0x"+strings.Repeat("0", 64)), want: "zero block hash"},
		"malformed address": {log: withLogAddress(valid, "0x1234"), want: "returned log address"},
	}
	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			if err := checkReturnedLog(tt.log, normalized); err == nil {
				t.Fatal("checkReturnedLog() = nil, want an error")
			} else if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error %q does not mention %q", err, tt.want)
			}
		})
	}
}

func TestRawLogFromGeth(t *testing.T) {
	supported := SupportedEventTopics()

	t.Run("converts every field", func(t *testing.T) {
		source := gethLog(1234, logTestAddress, supported[0], supported[1])
		converted, err := rawLogFromGeth(source)
		if err != nil {
			t.Fatalf("rawLogFromGeth() = %v, want nil", err)
		}
		if converted.Address != logTestAddress {
			t.Errorf("Address = %q, want %q", converted.Address, logTestAddress)
		}
		if !slices.Equal(converted.Topics, []string{supported[0], supported[1]}) {
			t.Errorf("Topics = %v, want the two supported topics", converted.Topics)
		}
		if converted.BlockNumber != 1234 {
			t.Errorf("BlockNumber = %d, want 1234", converted.BlockNumber)
		}
		if converted.TransactionIndex != 3 || converted.LogIndex != 7 {
			t.Errorf("indexes = %d and %d, want 3 and 7", converted.TransactionIndex, converted.LogIndex)
		}
		if !converted.Removed {
			t.Error("Removed = false, want the source flag preserved")
		}
		if string(converted.Data) != string([]byte{0xde, 0xad}) {
			t.Errorf("Data = %x, want dead", converted.Data)
		}
		if converted.BlockHash != "0x"+strings.Repeat("11", 32) {
			t.Errorf("BlockHash = %q, want the lowercase block hash", converted.BlockHash)
		}
		if converted.TransactionHash != "0x"+strings.Repeat("22", 32) {
			t.Errorf("TransactionHash = %q, want the lowercase transaction hash", converted.TransactionHash)
		}

		// The data slice must be a copy, not a view of the source.
		converted.Data[0] = 0xff
		if source.Data[0] != 0xde {
			t.Error("mutating the converted data changed the source log")
		}
	})

	t.Run("rejects malformed logs", func(t *testing.T) {
		noTopics := gethLog(10, logTestAddress)
		noTopics.Topics = nil

		zeroAddress := gethLog(10, logTestAddress, supported[0])
		zeroAddress.Address = common.Address{}

		zeroBlockHash := gethLog(10, logTestAddress, supported[0])
		zeroBlockHash.BlockHash = common.Hash{}

		zeroTxHash := gethLog(10, logTestAddress, supported[0])
		zeroTxHash.TxHash = common.Hash{}

		zeroTopic := gethLog(10, logTestAddress, "0x"+strings.Repeat("0", 64))

		cases := map[string]struct {
			log  types.Log
			want string
		}{
			"no topics":       {log: noTopics, want: "no topics"},
			"zero address":    {log: zeroAddress, want: "zero address"},
			"zero block hash": {log: zeroBlockHash, want: "zero block hash"},
			"zero tx hash":    {log: zeroTxHash, want: "zero transaction hash"},
			"zero topic":      {log: zeroTopic, want: "topic 0 is zero"},
		}
		for name, tt := range cases {
			t.Run(name, func(t *testing.T) {
				if _, err := rawLogFromGeth(tt.log); err == nil {
					t.Fatal("rawLogFromGeth() = nil, want an error")
				} else if !strings.Contains(err.Error(), tt.want) {
					t.Errorf("error %q does not mention %q", err, tt.want)
				}
			})
		}
	})
}

func TestLogQueryForFilter(t *testing.T) {
	supported := SupportedEventTopics()
	normalized, err := normalizeLogFilter(LogFilter{FromBlock: 0, ToBlock: 9, Address: logTestAddress})
	if err != nil {
		t.Fatalf("normalizeLogFilter() = %v, want nil", err)
	}

	query, err := logQueryForFilter(normalized)
	if err != nil {
		t.Fatalf("logQueryForFilter() = %v, want nil", err)
	}
	if query.FromBlock == nil || query.FromBlock.Uint64() != 0 {
		t.Errorf("FromBlock = %v, want 0", query.FromBlock)
	}
	if query.ToBlock == nil || query.ToBlock.Uint64() != 9 {
		t.Errorf("ToBlock = %v, want 9", query.ToBlock)
	}
	if len(query.Addresses) != 1 || strings.ToLower(query.Addresses[0].Hex()) != logTestAddress {
		t.Errorf("Addresses = %v, want the one filtered address", query.Addresses)
	}
	if len(query.Topics) != 1 || len(query.Topics[0]) != len(supported) {
		t.Fatalf("Topics = %v, want one position with %d topics", query.Topics, len(supported))
	}
	for i, topic := range query.Topics[0] {
		if strings.ToLower(topic.Hex()) != supported[i] {
			t.Errorf("topic %d = %s, want %s", i, topic.Hex(), supported[i])
		}
	}

	t.Run("rejects an empty topic position", func(t *testing.T) {
		empty := normalized
		empty.Topics = [][]string{{}}
		if _, err := logQueryForFilter(empty); err == nil {
			t.Fatal("logQueryForFilter() = nil, want an error")
		}
	})

	t.Run("rejects a malformed address or topic", func(t *testing.T) {
		badAddress := normalized
		badAddress.Address = "0x1234"
		if _, err := logQueryForFilter(badAddress); err == nil {
			t.Fatal("logQueryForFilter() = nil, want an error for a malformed address")
		}

		badTopic := normalized
		badTopic.Topics = [][]string{{"nope"}}
		if _, err := logQueryForFilter(badTopic); err == nil {
			t.Fatal("logQueryForFilter() = nil, want an error for a malformed topic")
		}
	})
}

func TestClientFilterLogs(t *testing.T) {
	ctx := t.Context()
	supported := SupportedEventTopics()

	validLog := RawLog{
		Address:          logTestAddress,
		Topics:           []string{supported[0], "0x" + strings.Repeat("33", 32)},
		BlockNumber:      150,
		BlockHash:        "0x" + strings.Repeat("11", 32),
		TransactionHash:  "0x" + strings.Repeat("22", 32),
		TransactionIndex: 1,
		LogIndex:         2,
	}

	t.Run("passes the canonical filter to the reader once", func(t *testing.T) {
		var recorded LogFilter
		var calls int
		c := &Client{reader: fakeReader{
			logs:        []RawLog{validLog},
			filterInput: &recorded,
			filterCalls: &calls,
		}}

		logs, err := c.FilterLogs(ctx, LogFilter{
			FromBlock: 100,
			ToBlock:   199,
			Address:   logTestChecksummedAddress,
			Topics:    [][]string{{supported[3], supported[0]}},
		})
		if err != nil {
			t.Fatalf("FilterLogs() = %v, want nil", err)
		}
		if calls != 1 {
			t.Errorf("reader calls = %d, want 1", calls)
		}
		if recorded.Address != logTestAddress {
			t.Errorf("reader address = %q, want the lowercase canonical form", recorded.Address)
		}
		if recorded.FromBlock != 100 || recorded.ToBlock != 199 {
			t.Errorf("reader range = %d..%d, want 100..199", recorded.FromBlock, recorded.ToBlock)
		}
		if !slices.Equal(recorded.Topics[0], []string{supported[0], supported[3]}) {
			t.Errorf("reader topics = %v, want the canonical order", recorded.Topics[0])
		}
		if len(logs) != 1 || logs[0].BlockNumber != 150 {
			t.Errorf("FilterLogs() = %+v, want the one returned log", logs)
		}
	})

	t.Run("returns logs in the order the endpoint sent them", func(t *testing.T) {
		first := validLog
		first.LogIndex = 9
		second := validLog
		second.LogIndex = 1
		second.BlockNumber = 120
		c := &Client{reader: fakeReader{logs: []RawLog{first, second}}}

		logs, err := c.FilterLogs(ctx, NewLogFilter(100, 199, logTestAddress))
		if err != nil {
			t.Fatalf("FilterLogs() = %v, want nil", err)
		}
		if len(logs) != 2 || logs[0].LogIndex != 9 || logs[1].LogIndex != 1 {
			t.Errorf("FilterLogs() reordered the logs: %+v", logs)
		}
	})

	t.Run("rejects an invalid filter before calling the reader", func(t *testing.T) {
		var calls int
		c := &Client{reader: fakeReader{filterCalls: &calls}}
		if _, err := c.FilterLogs(ctx, LogFilter{FromBlock: 9, ToBlock: 1, Address: logTestAddress}); err == nil {
			t.Fatal("FilterLogs() = nil, want a validation error")
		}
		if calls != 0 {
			t.Errorf("reader calls = %d, want 0", calls)
		}
	})

	t.Run("rejects a log the endpoint should not have returned", func(t *testing.T) {
		other := validLog
		other.Address = logTestOtherAddress
		c := &Client{reader: fakeReader{logs: []RawLog{other}}}
		if _, err := c.FilterLogs(ctx, NewLogFilter(100, 199, logTestAddress)); err == nil {
			t.Fatal("FilterLogs() = nil, want an error for a foreign log")
		}

		outside := validLog
		outside.BlockNumber = 500
		c = &Client{reader: fakeReader{logs: []RawLog{outside}}}
		if _, err := c.FilterLogs(ctx, NewLogFilter(100, 199, logTestAddress)); err == nil {
			t.Fatal("FilterLogs() = nil, want an error for a log outside the range")
		}
	})

	t.Run("wraps the reader error", func(t *testing.T) {
		c := &Client{reader: fakeReader{logsErr: fmt.Errorf("reader: %w", errRPC)}}
		if _, err := c.FilterLogs(ctx, NewLogFilter(1, 2, logTestAddress)); !errors.Is(err, errRPC) {
			t.Errorf("error = %v, want the wrapped reader error", err)
		}
	})

	t.Run("nil reader is rejected", func(t *testing.T) {
		if _, err := (&Client{}).FilterLogs(ctx, NewLogFilter(1, 2, logTestAddress)); err == nil {
			t.Fatal("FilterLogs() = nil, want an error for a nil reader")
		}
	})
}

// TestFilterLogsSingleBlockRange pins the inclusive single-block read, which is
// the narrowest range the scanner can ask for.
func TestFilterLogsSingleBlockRange(t *testing.T) {
	ctx := t.Context()
	var recorded LogFilter
	c := &Client{reader: fakeReader{
		logs: []RawLog{{
			Address:         logTestAddress,
			Topics:          []string{SupportedEventTopics()[0]},
			BlockNumber:     7,
			BlockHash:       "0x" + strings.Repeat("11", 32),
			TransactionHash: "0x" + strings.Repeat("22", 32),
		}},
		filterInput: &recorded,
	}}

	logs, err := c.FilterLogs(ctx, NewLogFilter(7, 7, logTestAddress))
	if err != nil {
		t.Fatalf("FilterLogs() = %v, want nil", err)
	}
	if len(logs) != 1 {
		t.Fatalf("logs = %d, want 1", len(logs))
	}
	if recorded.FromBlock != 7 || recorded.ToBlock != 7 {
		t.Errorf("reader range = %d..%d, want the single block 7", recorded.FromBlock, recorded.ToBlock)
	}
}

func withLogAddress(log RawLog, address string) RawLog {
	log.Address = address
	return log
}

func withLogBlock(log RawLog, blockNumber uint64) RawLog {
	log.BlockNumber = blockNumber
	return log
}

func withLogBlockHash(log RawLog, hash string) RawLog {
	log.BlockHash = hash
	return log
}
