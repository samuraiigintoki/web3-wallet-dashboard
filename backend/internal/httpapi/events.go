package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/indexer"
)

// IndexedEventsReader reads stored canonical contract events. It is the
// consumer-side seam the handler declares and cmd/api satisfies with the
// indexer repository, the same split as ReadinessChecker and RateLimiter, so
// the route is testable without a database.
type IndexedEventsReader interface {
	ListContractEvents(ctx context.Context, contractID int64, page indexer.EventPage) ([]indexer.Event, int, error)
}

// SubmitPayloadResponse is the wire shape of a SubmitTransaction payload. The
// value stays a decimal string and the calldata stays 0x hex, exactly as they
// are stored, so no uint256 can be narrowed to a float by serialization.
type SubmitPayloadResponse struct {
	To       string `json:"to"`
	ValueWei string `json:"valueWei"`
	Data     string `json:"data"`
}

// EventResponse is one indexed event. The metadata is chain identity; the
// payload carries typed, event-specific fields.
type EventResponse struct {
	ContractID       int64           `json:"contractId"`
	EventName        string          `json:"eventName"`
	BlockNumber      int64           `json:"blockNumber"`
	BlockHash        string          `json:"blockHash"`
	TransactionHash  string          `json:"transactionHash"`
	TransactionIndex int             `json:"transactionIndex"`
	LogIndex         int             `json:"logIndex"`
	ActorAddress     string          `json:"actorAddress"`
	MultisigTxIndex  string          `json:"multisigTxIndex"`
	Payload          json.RawMessage `json:"payload"`
}

type EventListEnvelope struct {
	Data       []EventResponse `json:"data"`
	Pagination Pagination      `json:"pagination"`
}

// listContractEvents returns one page of the caller's tracked contract events.
// Authorization is the same association check the other contract routes use, so
// an untracked or foreign contract is indistinguishable from a missing one.
func (h *Handler) listContractEvents(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}

	contractID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || contractID <= 0 {
		writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
		return
	}

	// The association authorizes the read. A disabled display toggle does not
	// withdraw it: the toggle affects what a user wants to see, never what the
	// indexer follows.
	if _, err := h.contractSvc.Get(r.Context(), u.ID, contractID); err != nil {
		if errors.Is(err, contract.ErrContractNotFound) {
			writeError(w, http.StatusNotFound, CodeResourceNotFound, contract.ErrContractNotFound.Error(), nil)
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	page, err := eventPageFromQuery(r)
	if err != nil {
		var vErr indexer.ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusBadRequest, CodeValidationError, vErr.Message, map[string]string{vErr.Field: vErr.Message})
			return
		}

		writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
		return
	}

	events, totalItems, err := h.events.ListContractEvents(r.Context(), contractID, page)
	if err != nil {
		var vErr indexer.ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusBadRequest, CodeValidationError, vErr.Message, map[string]string{vErr.Field: vErr.Message})
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	responses := make([]EventResponse, 0, len(events))
	for i := range events {
		response, err := eventToResponse(&events[i])
		if err != nil {
			// A stored row that does not satisfy the writer's own invariants is a
			// data problem, not something to return half of to a client.
			writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
			return
		}
		responses = append(responses, response)
	}

	var totalPages int64
	if totalItems > 0 {
		totalPages = (int64(totalItems) + int64(page.PageSize) - 1) / int64(page.PageSize)
	}

	writeJSON(w, http.StatusOK, EventListEnvelope{
		Data: responses,
		Pagination: Pagination{
			Page:       page.Page,
			PageSize:   page.PageSize,
			TotalItems: int64(totalItems),
			TotalPages: totalPages,
		},
	})
}

// eventPageFromQuery parses the pagination query parameters. An omitted or
// empty value takes the collection default; a value that is not an integer is a
// client error rather than a silent default.
func eventPageFromQuery(r *http.Request) (indexer.EventPage, error) {
	query := r.URL.Query()

	var page indexer.EventPage
	for _, parameter := range []struct {
		name string
		set  func(int)
	}{
		{name: "page", set: func(value int) { page.Page = value }},
		{name: "pageSize", set: func(value int) { page.PageSize = value }},
	} {
		raw := query.Get(parameter.name)
		if raw == "" {
			continue
		}
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return indexer.EventPage{}, fmt.Errorf("%s is not an integer", parameter.name)
		}
		parameter.set(int(parsed))
	}

	return page.Normalize()
}

// eventToResponse maps one stored event onto the wire DTO, re-validating the
// stored payload through the same helpers the writer used. Nothing is returned
// that the writer would have rejected.
func eventToResponse(event *indexer.Event) (EventResponse, error) {
	response := EventResponse{
		ContractID:       event.ContractID,
		EventName:        event.EventName,
		BlockNumber:      event.BlockNumber,
		BlockHash:        event.BlockHash,
		TransactionHash:  event.TransactionHash,
		TransactionIndex: event.TransactionIndex,
		LogIndex:         event.LogIndex,
		ActorAddress:     event.ActorAddress,
		MultisigTxIndex:  event.MultisigTxIndex,
	}

	if event.EventName == indexer.EventSubmitTransaction {
		payload, err := indexer.DecodeSubmitPayload(event.Payload)
		if err != nil {
			return EventResponse{}, fmt.Errorf("submit payload for block %d log %d: %w", event.BlockNumber, event.LogIndex, err)
		}
		encoded, err := json.Marshal(SubmitPayloadResponse{
			To:       payload.To,
			ValueWei: payload.ValueWei,
			Data:     payload.Data,
		})
		if err != nil {
			return EventResponse{}, fmt.Errorf("encode submit payload: %w", err)
		}
		response.Payload = encoded
		return response, nil
	}

	// The owner events carry an owner and a transaction index in their own
	// fields, so their payload is empty by construction.
	object, err := indexer.DecodePayloadObject(event.Payload)
	if err != nil {
		return EventResponse{}, fmt.Errorf("payload for %s at block %d log %d: %w", event.EventName, event.BlockNumber, event.LogIndex, err)
	}
	if len(object) != 0 {
		return EventResponse{}, fmt.Errorf("payload for %s at block %d log %d is not empty", event.EventName, event.BlockNumber, event.LogIndex)
	}
	response.Payload = json.RawMessage("{}")
	return response, nil
}
