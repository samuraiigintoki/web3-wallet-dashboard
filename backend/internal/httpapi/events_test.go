package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/indexer"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

// stubEventReader is the handler-level fake for indexed events. It records what
// the handler asked for and returns whatever a test scripted.
type stubEventReader struct {
	events []indexer.Event
	total  int
	err    error

	calls []eventReadCall
}

type eventReadCall struct {
	contractID int64
	page       indexer.EventPage
}

func (r *stubEventReader) ListContractEvents(_ context.Context, contractID int64, page indexer.EventPage) ([]indexer.Event, int, error) {
	r.calls = append(r.calls, eventReadCall{contractID: contractID, page: page})
	if r.err != nil {
		return nil, 0, r.err
	}
	return r.events, r.total, nil
}

// testEventReader is the reader the rest of the httpapi suite passes when it
// builds a router without caring about events.
func testEventReader() *stubEventReader {
	return &stubEventReader{}
}

// eventsHarness wires the router like the contract harness and keeps the events
// reader so a test can script and inspect it.
type eventsHarness struct {
	t      *testing.T
	router http.Handler
	reader *stubEventReader
}

func newEventsHarness(t *testing.T) *eventsHarness {
	t.Helper()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(
		chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true},
		chain.Chain{ChainID: 11155111, Name: "Sepolia", Symbol: "ETH", IsTestnet: true, Enabled: true},
	)
	chainSvc := chain.NewService(chainRepo)

	reader := testEventReader()
	router := NewRouter(
		wallet.NewService(wallet.NewInMemoryWalletRepo(), chainSvc),
		user.NewService(user.NewInMemoryRepository()),
		chainSvc,
		contract.NewService(contract.NewInMemoryRepository(), chainSvc),
		reader,
		testLogger(),
		&stubReadinessChecker{},
		unlimitedRateLimiter(),
		unlimitedRateLimiter(),
	)
	return &eventsHarness{t: t, router: router, reader: reader}
}

func (h *eventsHarness) do(method, path, body, token string) *httptest.ResponseRecorder {
	h.t.Helper()

	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

func (h *eventsHarness) token(email string) string {
	h.t.Helper()

	creds := fmt.Sprintf(`{"email":%q,"password":%q}`, email, testPassword)

	if rec := h.do(http.MethodPost, "/api/v1/auth/register", creds, ""); rec.Code != http.StatusCreated {
		h.t.Fatalf("register %s: expected 201, got %d body=%s", email, rec.Code, rec.Body.String())
	}
	rec := h.do(http.MethodPost, "/api/v1/auth/login", creds, "")
	if rec.Code != http.StatusOK {
		h.t.Fatalf("login %s: expected 200, got %d body=%s", email, rec.Code, rec.Body.String())
	}

	var env LoginResponseEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		h.t.Fatalf("decode login envelope: %v", err)
	}
	return env.Data.Token
}

func (h *eventsHarness) track(token, address string, chainID, startBlock int64) int64 {
	h.t.Helper()

	body := fmt.Sprintf(`{"address":%q,"chainId":%d,"label":"tracked","startBlock":%d}`, address, chainID, startBlock)
	rec := h.do(http.MethodPost, "/api/v1/contracts", body, token)
	if rec.Code != http.StatusCreated {
		h.t.Fatalf("track %s: expected 201, got %d body=%s", address, rec.Code, rec.Body.String())
	}

	var env ContractResponseEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		h.t.Fatalf("decode create envelope: %v", err)
	}
	return env.Data.ID
}

func (h *eventsHarness) getEvents(token string, contractID int64, query string) *httptest.ResponseRecorder {
	h.t.Helper()

	return h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d/events%s", contractID, query), "", token)
}

func (h *eventsHarness) events(t *testing.T, token string, contractID int64, query string) EventListEnvelope {
	t.Helper()

	rec := h.getEvents(token, contractID, query)
	if rec.Code != http.StatusOK {
		t.Fatalf("events %q: expected 200, got %d body=%s", query, rec.Code, rec.Body.String())
	}

	var env EventListEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode events envelope: %v", err)
	}
	return env
}

// submitEvent builds a stored submit event whose payload is exactly what the
// indexer writes.
func submitEvent(t *testing.T, contractID int64) indexer.Event {
	t.Helper()

	value, ok := new(big.Int).SetString("1000000000000000000", 10)
	if !ok {
		t.Fatal("parse submit value")
	}
	payload, err := indexer.EncodeSubmitPayload("0x00000000000000000000000000000000000000a1", value, []byte{0x01, 0x02, 0x03})
	if err != nil {
		t.Fatalf("encode submit payload: %v", err)
	}

	return indexer.Event{
		ContractID:       contractID,
		EventName:        indexer.EventSubmitTransaction,
		BlockNumber:      4200,
		BlockHash:        "0x" + strings.Repeat("ab", 32),
		TransactionHash:  "0x" + strings.Repeat("cd", 32),
		TransactionIndex: 3,
		LogIndex:         1,
		ActorAddress:     "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746",
		MultisigTxIndex:  "18446744073709551617",
		Payload:          payload,
	}
}

func ownerEvent(contractID int64) indexer.Event {
	return indexer.Event{
		ContractID:       contractID,
		EventName:        indexer.EventConfirmTransaction,
		BlockNumber:      4199,
		BlockHash:        "0x" + strings.Repeat("11", 32),
		TransactionHash:  "0x" + strings.Repeat("22", 32),
		TransactionIndex: 0,
		LogIndex:         4,
		ActorAddress:     "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746",
		MultisigTxIndex:  "7",
		Payload:          []byte("{}"),
	}
}

func TestContractEventsRequireAuthentication(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-auth@example.com")
	contractID := h.track(token, "0x00000000000000000000000000000000000000a1", 11155111, 100)

	cases := map[string]string{
		"no token":  "",
		"malformed": "not-a-token",
		"unknown":   "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}
	for name, candidate := range cases {
		t.Run(name, func(t *testing.T) {
			rec := h.getEvents(candidate, contractID, "")
			assertErrorCode(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
		})
	}
	if len(h.reader.calls) != 0 {
		t.Errorf("reads = %d, want none for an unauthenticated request", len(h.reader.calls))
	}
}

func TestContractEventsConcealForeignAndMissingContracts(t *testing.T) {
	h := newEventsHarness(t)
	owner := h.token("events-owner@example.com")
	other := h.token("events-other@example.com")
	tracked := h.track(owner, "0x00000000000000000000000000000000000000a2", 11155111, 100)

	foreign := h.getEvents(other, tracked, "")
	missing := h.getEvents(other, tracked+1000, "")

	assertErrorCode(t, foreign, http.StatusNotFound, CodeResourceNotFound)
	assertErrorCode(t, missing, http.StatusNotFound, CodeResourceNotFound)
	if foreign.Body.String() != missing.Body.String() {
		t.Errorf("foreign and missing contracts must be indistinguishable:\nforeign: %s\nmissing: %s",
			foreign.Body.String(), missing.Body.String())
	}
	if len(h.reader.calls) != 0 {
		t.Errorf("reads = %d, want none when the association is absent", len(h.reader.calls))
	}

	// The owner reads its own contract.
	h.reader.total = 0
	if rec := h.getEvents(owner, tracked, ""); rec.Code != http.StatusOK {
		t.Fatalf("owner read: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestContractEventsRejectInvalidContractID(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-id@example.com")

	for _, id := range []string{"0", "-3", "abc"} {
		rec := h.do(http.MethodGet, "/api/v1/contracts/"+id+"/events", "", token)
		assertErrorCode(t, rec, http.StatusBadRequest, CodeValidationError)
		assertNoDetails(t, rec)
	}
	if len(h.reader.calls) != 0 {
		t.Errorf("reads = %d, want none for an invalid id", len(h.reader.calls))
	}
}

func TestContractEventsDisabledDisplayToggleStillAuthorizes(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-toggle@example.com")
	contractID := h.track(token, "0x00000000000000000000000000000000000000a3", 11155111, 100)

	rec := h.do(http.MethodPatch, fmt.Sprintf("/api/v1/contracts/%d", contractID), `{"enabled":false}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("disable toggle: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	h.reader.events = []indexer.Event{ownerEvent(contractID)}
	h.reader.total = 1

	env := h.events(t, token, contractID, "")
	if len(env.Data) != 1 {
		t.Fatalf("events = %d, want the event read to survive a disabled display toggle", len(env.Data))
	}
}

func TestContractEventsPaginationDefaultsAndPassThrough(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-page@example.com")
	contractID := h.track(token, "0x00000000000000000000000000000000000000a4", 11155111, 100)

	cases := map[string]struct {
		query        string
		wantPage     int
		wantPageSize int
	}{
		"no query":          {query: "", wantPage: 1, wantPageSize: 20},
		"explicit":          {query: "?page=3&pageSize=5", wantPage: 3, wantPageSize: 5},
		"zeros use default": {query: "?page=0&pageSize=0", wantPage: 1, wantPageSize: 20},
		"page size at cap":  {query: "?pageSize=100", wantPage: 1, wantPageSize: 100},
	}

	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			h.reader.calls = nil
			h.reader.total = 42 + tt.wantPage*100

			env := h.events(t, token, contractID, tt.query)
			if env.Pagination.Page != tt.wantPage || env.Pagination.PageSize != tt.wantPageSize {
				t.Errorf("pagination = %d/%d, want %d/%d",
					env.Pagination.Page, env.Pagination.PageSize, tt.wantPage, tt.wantPageSize)
			}
			if len(h.reader.calls) != 1 {
				t.Fatalf("reads = %d, want 1", len(h.reader.calls))
			}
			call := h.reader.calls[0]
			if call.contractID != contractID {
				t.Errorf("read contract = %d, want %d", call.contractID, contractID)
			}
			if call.page.Page != tt.wantPage || call.page.PageSize != tt.wantPageSize {
				t.Errorf("effective page = %d/%d, want %d/%d",
					call.page.Page, call.page.PageSize, tt.wantPage, tt.wantPageSize)
			}
		})
	}
}

func TestContractEventsPaginationValidation(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-page-invalid@example.com")
	contractID := h.track(token, "0x00000000000000000000000000000000000000a5", 11155111, 100)

	cases := map[string]struct {
		query     string
		wantField string
	}{
		"page is not an integer":      {query: "?page=abc", wantField: ""},
		"page size is not an integer": {query: "?pageSize=1.5", wantField: ""},
		"page over the cap":           {query: "?page=10001", wantField: "page"},
		"page size over the cap":      {query: "?pageSize=101", wantField: "pageSize"},
	}

	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			rec := h.getEvents(token, contractID, tt.query)
			if tt.wantField == "" {
				assertErrorCode(t, rec, http.StatusBadRequest, CodeValidationError)
				assertNoDetails(t, rec)
				return
			}
			assertValidationDetails(t, rec, http.StatusBadRequest, tt.wantField)
		})
	}
	if len(h.reader.calls) != 0 {
		t.Errorf("reads = %d, want none for rejected pagination", len(h.reader.calls))
	}
}

func TestContractEventsEmptyAndPastLastPage(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-empty@example.com")
	contractID := h.track(token, "0x00000000000000000000000000000000000000a6", 11155111, 100)

	// No canonical events at all.
	h.reader.total = 0
	env := h.events(t, token, contractID, "")
	if env.Data == nil || len(env.Data) != 0 {
		t.Errorf("data = %v, want an empty array rather than null", env.Data)
	}
	if env.Pagination.TotalItems != 0 || env.Pagination.TotalPages != 0 {
		t.Errorf("pagination = %+v, want zero totals", env.Pagination)
	}

	// A page past the last page answers with an empty array and true totals.
	h.reader.events = nil
	h.reader.total = 3
	rec := h.getEvents(token, contractID, "?page=9&pageSize=20")
	if rec.Code != http.StatusOK {
		t.Fatalf("page past the end: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var past EventListEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &past); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if len(past.Data) != 0 {
		t.Errorf("data = %v, want an empty page", past.Data)
	}
	if past.Pagination.TotalItems != 3 || past.Pagination.TotalPages != 1 {
		t.Errorf("pagination = %+v, want the true totals", past.Pagination)
	}

	// The body really carries an empty array, not null.
	if !strings.Contains(rec.Body.String(), `"data":[]`) {
		t.Errorf("body = %s, want an empty data array", rec.Body.String())
	}
}

func TestContractEventsSerializeMetadataAndPayloads(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-payload@example.com")
	contractID := h.track(token, "0x00000000000000000000000000000000000000a7", 11155111, 100)

	h.reader.events = []indexer.Event{submitEvent(t, contractID), ownerEvent(contractID)}
	h.reader.total = 2

	rec := h.getEvents(token, contractID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	// The raw body proves the types: a uint256 is a string, never a JSON number.
	body := rec.Body.String()
	if !strings.Contains(body, `"valueWei":"1000000000000000000"`) {
		t.Errorf("body = %s, want valueWei as a decimal string", body)
	}
	if !strings.Contains(body, `"multisigTxIndex":"18446744073709551617"`) {
		t.Errorf("body = %s, want multisigTxIndex as a decimal string", body)
	}
	if !strings.Contains(body, `"data":"0x010203"`) {
		t.Errorf("body = %s, want calldata as 0x hex", body)
	}

	var env EventListEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if len(env.Data) != 2 {
		t.Fatalf("events = %d, want 2", len(env.Data))
	}

	submit := env.Data[0]
	if submit.ContractID != contractID || submit.EventName != indexer.EventSubmitTransaction {
		t.Errorf("submit identity = %+v", submit)
	}
	if submit.BlockNumber != 4200 || submit.TransactionIndex != 3 || submit.LogIndex != 1 {
		t.Errorf("submit position = %+v", submit)
	}
	if submit.BlockHash != "0x"+strings.Repeat("ab", 32) || submit.TransactionHash != "0x"+strings.Repeat("cd", 32) {
		t.Errorf("submit hashes = %+v", submit)
	}
	if submit.ActorAddress != "0x14912965632cd9ab70c046e8d23e9b8dfa9f2746" {
		t.Errorf("submit actor = %q", submit.ActorAddress)
	}

	var payload SubmitPayloadResponse
	if err := json.Unmarshal(submit.Payload, &payload); err != nil {
		t.Fatalf("decode submit payload: %v", err)
	}
	if payload.To != "0x00000000000000000000000000000000000000a1" || payload.ValueWei != "1000000000000000000" || payload.Data != "0x010203" {
		t.Errorf("submit payload = %+v", payload)
	}

	owner := env.Data[1]
	if owner.EventName != indexer.EventConfirmTransaction || owner.MultisigTxIndex != "7" {
		t.Errorf("owner event = %+v", owner)
	}
	if string(owner.Payload) != "{}" {
		t.Errorf("owner payload = %s, want an empty object", owner.Payload)
	}
}

func TestContractEventsRejectMalformedStoredPayload(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-bad-payload@example.com")
	contractID := h.track(token, "0x00000000000000000000000000000000000000a8", 11155111, 100)

	badSubmit := submitEvent(t, contractID)
	badSubmit.Payload = []byte(`{"to":"not-an-address","valueWei":"1","data":"0x"}`)

	badOwner := ownerEvent(contractID)
	badOwner.Payload = []byte(`{"owner":"0xunexpected"}`)

	for name, event := range map[string]indexer.Event{"submit": badSubmit, "owner": badOwner} {
		t.Run(name, func(t *testing.T) {
			h.reader.events = []indexer.Event{event}
			h.reader.total = 1

			rec := h.getEvents(token, contractID, "")
			assertErrorCode(t, rec, http.StatusInternalServerError, CodeInternalError)
			if strings.Contains(rec.Body.String(), "not-an-address") {
				t.Errorf("body leaked stored payload content: %s", rec.Body.String())
			}
		})
	}
}

func TestContractEventsReaderFailure(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-reader-error@example.com")
	contractID := h.track(token, "0x00000000000000000000000000000000000000a9", 11155111, 100)

	h.reader.err = errors.New("database is not available")
	rec := h.getEvents(token, contractID, "")
	assertErrorCode(t, rec, http.StatusInternalServerError, CodeInternalError)

	// A validation failure from the reader is a client error, the same way the
	// other collections report one.
	h.reader.err = indexer.ValidationError{Field: "pageSize", Message: "pageSize must not exceed 100"}
	rec = h.getEvents(token, contractID, "")
	assertValidationDetails(t, rec, http.StatusBadRequest, "pageSize")
}

// disabledIndexingRepository reports every tracked contract as globally
// indexing-disabled, the state an operator produces outside the API.
type disabledIndexingRepository struct {
	*contract.InMemoryRepository
}

func (r disabledIndexingRepository) GetTracking(ctx context.Context, userID, contractID int64) (*contract.TrackedContract, error) {
	tracked, err := r.InMemoryRepository.GetTracking(ctx, userID, contractID)
	if err != nil {
		return nil, err
	}
	tracked.IndexingEnabled = false
	return tracked, nil
}

func (r disabledIndexingRepository) ListForUser(ctx context.Context, userID int64, filter contract.ListFilter) ([]contract.TrackedContract, int, error) {
	list, total, err := r.InMemoryRepository.ListForUser(ctx, userID, filter)
	for i := range list {
		list[i].IndexingEnabled = false
	}
	return list, total, err
}

func TestContractIndexingStatusMapping(t *testing.T) {
	h := newEventsHarness(t)
	token := h.token("events-status@example.com")

	// Sepolia, indexing enabled, nothing indexed yet.
	sepoliaID := h.track(token, "0x00000000000000000000000000000000000000b1", 11155111, 100)
	// A chain the indexer does not serve.
	mainnetID := h.track(token, "0x00000000000000000000000000000000000000b2", 1, 19000000)

	sepoliaRec := h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", sepoliaID), "", token)
	assertIndexingStatus(t, sepoliaRec, "pending")
	mainnetRec := h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", mainnetID), "", token)
	assertIndexingStatus(t, mainnetRec, "unsupported")

	// The list route carries the same field for every item.
	listRec := h.do(http.MethodGet, "/api/v1/contracts", "", token)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d body=%s", listRec.Code, listRec.Body.String())
	}
	var listEnv struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listEnv); err != nil {
		t.Fatalf("decode list envelope: %v", err)
	}
	want := map[int64]string{sepoliaID: "pending", mainnetID: "unsupported"}
	for _, item := range listEnv.Data {
		id, _ := item["id"].(float64)
		if got, ok := item["indexingStatus"].(string); !ok || got != want[int64(id)] {
			t.Errorf("list item %v indexingStatus = %v, want %q", item["id"], item["indexingStatus"], want[int64(id)])
		}
	}
}

func TestContractIndexingStatusDisabledWinsOverChain(t *testing.T) {
	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(
		chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true},
		chain.Chain{ChainID: 11155111, Name: "Sepolia", Symbol: "ETH", IsTestnet: true, Enabled: true},
	)
	chainSvc := chain.NewService(chainRepo)

	repo := disabledIndexingRepository{InMemoryRepository: contract.NewInMemoryRepository()}
	router := NewRouter(
		wallet.NewService(wallet.NewInMemoryWalletRepo(), chainSvc),
		user.NewService(user.NewInMemoryRepository()),
		chainSvc,
		contract.NewService(repo, chainSvc),
		testEventReader(),
		testLogger(),
		&stubReadinessChecker{},
		unlimitedRateLimiter(),
		unlimitedRateLimiter(),
	)
	h := &eventsHarness{t: t, router: router, reader: testEventReader()}

	token := h.token("events-status-disabled@example.com")
	sepoliaID := h.track(token, "0x00000000000000000000000000000000000000c1", 11155111, 100)
	mainnetID := h.track(token, "0x00000000000000000000000000000000000000c2", 1, 19000000)

	assertIndexingStatus(t, h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", sepoliaID), "", token), "disabled")
	assertIndexingStatus(t, h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", mainnetID), "", token), "disabled")
}

func TestIndexingStatusForUsesOnlyThreeValues(t *testing.T) {
	cases := map[string]struct {
		tracked contract.TrackedContract
		want    string
	}{
		"enabled on the indexed chain":   {tracked: contract.TrackedContract{ChainID: 11155111, IndexingEnabled: true}, want: "pending"},
		"enabled on another chain":       {tracked: contract.TrackedContract{ChainID: 1, IndexingEnabled: true}, want: "unsupported"},
		"globally disabled on the chain": {tracked: contract.TrackedContract{ChainID: 11155111, IndexingEnabled: false}, want: "disabled"},
		"globally disabled on another":   {tracked: contract.TrackedContract{ChainID: 137, IndexingEnabled: false}, want: "disabled"},
		"sepolia chain id constant":      {tracked: contract.TrackedContract{ChainID: sepoliaChainID, IndexingEnabled: true}, want: "pending"},
	}

	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			if got := indexingStatusFor(&tt.tracked); got != tt.want {
				t.Errorf("indexingStatusFor(%+v) = %q, want %q", tt.tracked, got, tt.want)
			}
		})
	}
}

func assertIndexingStatus(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var raw struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode contract envelope: %v", err)
	}
	if got, ok := raw.Data["indexingStatus"].(string); !ok || got != want {
		t.Fatalf("indexingStatus = %v, want %q (body=%s)", raw.Data["indexingStatus"], want, rec.Body.String())
	}
	for _, forbidden := range []string{"lastError", "last_error", "running", "idle", "error"} {
		if _, present := raw.Data[forbidden]; present {
			t.Errorf("contract response carries %q", forbidden)
		}
	}
}
