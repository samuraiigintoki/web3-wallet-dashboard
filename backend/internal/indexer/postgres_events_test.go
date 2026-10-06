package indexer

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

// eventAt builds one stored event at an exact chain position, so ordering and
// pagination can be asserted against a known sequence.
func eventAt(t *testing.T, contractID int64, name string, blockNumber int64, transactionIndex, logIndex int, tag int) Event {
	t.Helper()

	metadata := EventMetadata{
		BlockNumber:      blockNumber,
		BlockHash:        hashFor(blockNumber, 1),
		TransactionHash:  hashFor(blockNumber, 100+transactionIndex),
		TransactionIndex: transactionIndex,
		LogIndex:         logIndex,
	}

	if name == EventSubmitTransaction {
		value := mustUint256(t, "1000000000000000000")
		event, err := NewSubmitTransactionEvent(contractID, metadata, indexerTestOwner, uint64(tag),
			"0x00000000000000000000000000000000000000d1", value, []byte{0x01, 0x02, 0x03})
		if err != nil {
			t.Fatalf("build submit event: %v", err)
		}
		return event
	}

	event, err := NewOwnerEvent(contractID, metadata, name, indexerTestOwner, uint64(tag))
	if err != nil {
		t.Fatalf("build %s event: %v", name, err)
	}
	return event
}

// seedEventHistory commits five events across three blocks and returns the
// contract id. Log indices are unique inside a block, as they are on chain, and
// newest first the history is:
//
//	block 1002 tx 0 log 0  SubmitTransaction
//	block 1001 tx 0 log 1  ExecuteTransaction
//	block 1001 tx 0 log 0  ConfirmTransaction
//	block 1000 tx 1 log 1  ConfirmTransaction
//	block 1000 tx 0 log 0  SubmitTransaction
func seedEventHistory(t *testing.T, db *sql.DB, repo *PostgresRepository, chainID int64, address string) int64 {
	t.Helper()

	contractID := seedIndexerTestDeployment(t, db, chainID, address, 1000)
	if _, err := repo.EnsureCheckpoint(t.Context(), contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	first := testRangeCommit(contractID, 1000, 1001, []Event{
		eventAt(t, contractID, EventSubmitTransaction, 1000, 0, 0, 1),
		eventAt(t, contractID, EventConfirmTransaction, 1000, 1, 1, 1),
		eventAt(t, contractID, EventConfirmTransaction, 1001, 0, 0, 1),
		eventAt(t, contractID, EventExecuteTransaction, 1001, 0, 1, 1),
	})
	if _, err := repo.CommitRange(t.Context(), first); err != nil {
		t.Fatalf("commit first range: %v", err)
	}

	second := testRangeCommit(contractID, 1002, 1002, []Event{
		eventAt(t, contractID, EventSubmitTransaction, 1002, 0, 0, 2),
	})
	if _, err := repo.CommitRange(t.Context(), second); err != nil {
		t.Fatalf("commit second range: %v", err)
	}
	return contractID
}

func TestPostgresIndexer_ListContractEventsOrderAndPagination(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	contractID := seedEventHistory(t, db, repo, indexerTestChainSepolia, "0x00000000000000000000000000000000000001d1")
	otherID := seedEventHistory(t, db, repo, indexerTestChainSepolia, "0x00000000000000000000000000000000000001d2")

	t.Run("newest first across blocks, transactions and logs", func(t *testing.T) {
		events, total, err := repo.ListContractEvents(ctx, contractID, EventPage{})
		if err != nil {
			t.Fatalf("ListContractEvents() = %v, want nil", err)
		}
		if total != 5 {
			t.Fatalf("totalItems = %d, want 5", total)
		}
		if len(events) != 5 {
			t.Fatalf("events = %d, want 5", len(events))
		}

		want := []struct {
			name             string
			blockNumber      int64
			transactionIndex int
			logIndex         int
		}{
			{EventSubmitTransaction, 1002, 0, 0},
			{EventExecuteTransaction, 1001, 0, 1},
			{EventConfirmTransaction, 1001, 0, 0},
			{EventConfirmTransaction, 1000, 1, 1},
			{EventSubmitTransaction, 1000, 0, 0},
		}
		for i, expected := range want {
			event := events[i]
			if event.EventName != expected.name || event.BlockNumber != expected.blockNumber ||
				event.TransactionIndex != expected.transactionIndex || event.LogIndex != expected.logIndex {
				t.Errorf("event %d = %s at %d/%d/%d, want %s at %d/%d/%d", i,
					event.EventName, event.BlockNumber, event.TransactionIndex, event.LogIndex,
					expected.name, expected.blockNumber, expected.transactionIndex, expected.logIndex)
			}
			if event.ContractID != contractID {
				t.Errorf("event %d contract = %d, want %d", i, event.ContractID, contractID)
			}
			if event.BlockHash != hashFor(expected.blockNumber, 1) {
				t.Errorf("event %d block hash = %q, want the committed header", i, event.BlockHash)
			}
			if event.ActorAddress != indexerTestOwner {
				t.Errorf("event %d actor = %q, want %q", i, event.ActorAddress, indexerTestOwner)
			}
			if event.Removed {
				t.Errorf("event %d is marked removed", i)
			}
		}

		// The submit payload survives the round trip with its types intact.
		payload, err := DecodeSubmitPayload(events[0].Payload)
		if err != nil {
			t.Fatalf("decode submit payload: %v", err)
		}
		if payload.ValueWei != "1000000000000000000" || payload.Data != "0x010203" {
			t.Errorf("submit payload = %+v", payload)
		}
		if events[0].MultisigTxIndex != "2" {
			t.Errorf("multisig index = %q, want the decimal string 2", events[0].MultisigTxIndex)
		}
	})

	t.Run("pages slice the same order", func(t *testing.T) {
		type pageExpectation struct {
			page     int
			wantName []string
		}
		cases := []pageExpectation{
			{page: 1, wantName: []string{EventSubmitTransaction, EventExecuteTransaction}},
			{page: 2, wantName: []string{EventConfirmTransaction, EventConfirmTransaction}},
			{page: 3, wantName: []string{EventSubmitTransaction}},
		}
		for _, tc := range cases {
			events, total, err := repo.ListContractEvents(ctx, contractID, EventPage{Page: tc.page, PageSize: 2})
			if err != nil {
				t.Fatalf("page %d: ListContractEvents() = %v, want nil", tc.page, err)
			}
			if total != 5 {
				t.Errorf("page %d: totalItems = %d, want 5", tc.page, total)
			}
			if len(events) != len(tc.wantName) {
				t.Fatalf("page %d: events = %d, want %d", tc.page, len(events), len(tc.wantName))
			}
			for i, want := range tc.wantName {
				if events[i].EventName != want {
					t.Errorf("page %d event %d = %s, want %s", tc.page, i, events[i].EventName, want)
				}
			}
		}
	})

	t.Run("page size at the cap", func(t *testing.T) {
		events, total, err := repo.ListContractEvents(ctx, contractID, EventPage{Page: 1, PageSize: MaxEventPageSize})
		if err != nil {
			t.Fatalf("ListContractEvents() = %v, want nil", err)
		}
		if len(events) != 5 || total != 5 {
			t.Errorf("events = %d total = %d, want 5 and 5", len(events), total)
		}
	})

	t.Run("a page past the end is empty", func(t *testing.T) {
		events, total, err := repo.ListContractEvents(ctx, contractID, EventPage{Page: 9, PageSize: 2})
		if err != nil {
			t.Fatalf("ListContractEvents() = %v, want nil", err)
		}
		if len(events) != 0 {
			t.Errorf("events = %d, want none", len(events))
		}
		if total != 5 {
			t.Errorf("totalItems = %d, want the true count 5", total)
		}
	})

	t.Run("reads stay scoped to one contract", func(t *testing.T) {
		events, total, err := repo.ListContractEvents(ctx, otherID, EventPage{})
		if err != nil {
			t.Fatalf("ListContractEvents() = %v, want nil", err)
		}
		if total != 5 {
			t.Errorf("totalItems = %d, want the other contract's 5", total)
		}
		for _, event := range events {
			if event.ContractID != otherID {
				t.Errorf("event belongs to contract %d, want %d", event.ContractID, otherID)
			}
		}
	})
}

func TestPostgresIndexer_ListContractEventsExcludesRemoved(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	contractID := seedEventHistory(t, db, repo, indexerTestChainSepolia, "0x00000000000000000000000000000000000001e1")

	// A rewind at block 1001 orphans the event at 1002. The row stays as
	// history, but it is no longer canonical and must not be served.
	if _, err := repo.RewindToAncestor(ctx, contractID, 1001); err != nil {
		t.Fatalf("rewind: %v", err)
	}
	if got := indexerTestCountWhere(t, db, "contract_events", contractID, "removed"); got != 1 {
		t.Fatalf("removed rows = %d, want the orphan kept as history", got)
	}

	events, total, err := repo.ListContractEvents(ctx, contractID, EventPage{})
	if err != nil {
		t.Fatalf("ListContractEvents() = %v, want nil", err)
	}
	if total != 4 {
		t.Errorf("totalItems = %d, want 4 canonical events", total)
	}
	if len(events) != 4 {
		t.Fatalf("events = %d, want 4", len(events))
	}
	for i, event := range events {
		if event.BlockNumber == 1002 {
			t.Errorf("event %d is the removed block 1002 event", i)
		}
		if event.Removed {
			t.Errorf("event %d is marked removed", i)
		}
	}
	if events[0].BlockNumber != 1001 || events[0].LogIndex != 1 {
		t.Errorf("newest canonical event = block %d log %d, want block 1001 log 1", events[0].BlockNumber, events[0].LogIndex)
	}

	// The last page now has two items and the third page is empty, which proves
	// the count and the page agree about the removed row.
	events, total, err = repo.ListContractEvents(ctx, contractID, EventPage{Page: 3, PageSize: 2})
	if err != nil {
		t.Fatalf("third page: ListContractEvents() = %v, want nil", err)
	}
	if len(events) != 0 || total != 4 {
		t.Errorf("third page = %d events with total %d, want none and 4", len(events), total)
	}
}

func TestPostgresIndexer_ListContractEventsOnlyRemovedEvents(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x00000000000000000000000000000000000001f1", 500)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}
	commit := testRangeCommit(contractID, 500, 501, []Event{
		eventAt(t, contractID, EventConfirmTransaction, 500, 0, 0, 1),
		eventAt(t, contractID, EventExecuteTransaction, 501, 0, 0, 1),
	})
	if _, err := repo.CommitRange(ctx, commit); err != nil {
		t.Fatalf("commit range: %v", err)
	}

	// A full rewind leaves every event removed and nothing canonical.
	if _, err := repo.RewindToStart(ctx, contractID); err != nil {
		t.Fatalf("rewind to start: %v", err)
	}

	events, total, err := repo.ListContractEvents(ctx, contractID, EventPage{})
	if err != nil {
		t.Fatalf("ListContractEvents() = %v, want nil", err)
	}
	if len(events) != 0 || total != 0 {
		t.Errorf("events = %d total = %d, want an empty canonical history", len(events), total)
	}
}

func TestPostgresIndexer_ListContractEventsValidation(t *testing.T) {
	db, repo := setupPostgresIndexerTest(t)
	ctx := t.Context()

	contractID := seedIndexerTestDeployment(t, db, indexerTestChainSepolia, "0x0000000000000000000000000000000000000201", 100)
	if _, err := repo.EnsureCheckpoint(ctx, contractID); err != nil {
		t.Fatalf("ensure checkpoint: %v", err)
	}

	cases := map[string]struct {
		contractID int64
		page       EventPage
		wantField  string
	}{
		"zero contract":      {contractID: 0, wantField: "contractId"},
		"negative contract":  {contractID: -2, wantField: "contractId"},
		"page over the cap":  {contractID: contractID, page: EventPage{Page: MaxEventPage + 1}, wantField: "page"},
		"page size over cap": {contractID: contractID, page: EventPage{PageSize: MaxEventPageSize + 1}, wantField: "pageSize"},
	}

	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			events, total, err := repo.ListContractEvents(ctx, tt.contractID, tt.page)
			if err == nil {
				t.Fatalf("ListContractEvents() = %d events with total %d, want a validation error", len(events), total)
			}
			var validation ValidationError
			if !errors.As(err, &validation) {
				t.Fatalf("error %v, want a ValidationError", err)
			}
			if validation.Field != tt.wantField {
				t.Errorf("field = %q, want %q", validation.Field, tt.wantField)
			}
		})
	}

	// Defaults are applied rather than rejected.
	events, total, err := repo.ListContractEvents(ctx, contractID, EventPage{Page: 0, PageSize: 0})
	if err != nil {
		t.Fatalf("defaults: ListContractEvents() = %v, want nil", err)
	}
	if len(events) != 0 || total != 0 {
		t.Errorf("defaults: events = %d total = %d, want an empty result", len(events), total)
	}
}

func TestEventPageNormalize(t *testing.T) {
	normalized, err := (EventPage{}).Normalize()
	if err != nil {
		t.Fatalf("Normalize() = %v, want nil", err)
	}
	if normalized.Page != DefaultEventPage || normalized.PageSize != DefaultEventPageSize {
		t.Errorf("defaults = %d/%d, want %d/%d", normalized.Page, normalized.PageSize, DefaultEventPage, DefaultEventPageSize)
	}
	if offset := normalized.Offset(); offset != 0 {
		t.Errorf("offset = %d, want 0", offset)
	}

	normalized, err = (EventPage{Page: 3, PageSize: 20}).Normalize()
	if err != nil {
		t.Fatalf("Normalize() = %v, want nil", err)
	}
	if offset := normalized.Offset(); offset != 40 {
		t.Errorf("offset = %d, want 40", offset)
	}

	// A payload written by the older writer shape still decodes: the type is
	// what the API serializes, so the guard is asserted here too.
	var payload SubmitPayload
	if err := json.Unmarshal([]byte(`{"to":"0x00000000000000000000000000000000000000d1","valueWei":"1","data":"0x"}`), &payload); err != nil {
		t.Fatalf("decode payload literal: %v", err)
	}
	if payload.ValueWei != "1" {
		t.Errorf("value = %q, want the decimal string", payload.ValueWei)
	}
}
