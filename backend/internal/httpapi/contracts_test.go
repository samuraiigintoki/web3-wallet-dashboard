package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

// The suite runs against in-memory services only, so it needs no DATABASE_URL —
// same as wallets_test.go. Chains are seeded with the three catalog ids the
// service validates against.

// contractsHarness wires the router the way auth_test/wallets_test do, and adds
// register+login so every request carries a real session token.
type contractsHarness struct {
	t      *testing.T
	router http.Handler
}

func newContractsHarness(t *testing.T) *contractsHarness {
	t.Helper()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(
		chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true},
		chain.Chain{ChainID: 137, Name: "Polygon", Symbol: "POL", Enabled: true},
		chain.Chain{ChainID: 11155111, Name: "Sepolia", Symbol: "ETH", IsTestnet: true, Enabled: true},
	)
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(wallet.NewInMemoryWalletRepo(), chainSvc)
	userSvc := user.NewService(user.NewInMemoryRepository())
	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	return &contractsHarness{t: t, router: NewRouter(walletSvc, userSvc, chainSvc, contractSvc)}
}

func (h *contractsHarness) do(method, path, body, token string) *httptest.ResponseRecorder {
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

// token registers and logs in a fresh user and returns its bearer token.
func (h *contractsHarness) token(email string) string {
	h.t.Helper()

	creds := fmt.Sprintf(`{"email":%q,"password":"password123"}`, email)

	rec := h.do(http.MethodPost, "/api/v1/auth/register", creds, "")
	if rec.Code != http.StatusCreated {
		h.t.Fatalf("register %s: expected 201, got %d body=%s", email, rec.Code, rec.Body.String())
	}

	rec = h.do(http.MethodPost, "/api/v1/auth/login", creds, "")
	if rec.Code != http.StatusOK {
		h.t.Fatalf("login %s: expected 200, got %d body=%s", email, rec.Code, rec.Body.String())
	}

	var env LoginResponseEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		h.t.Fatalf("decode login envelope: %v", err)
	}
	if env.Data.Token == "" {
		h.t.Fatalf("login %s returned an empty token", email)
	}
	return env.Data.Token
}

// create posts a tracking and returns the decoded record, failing on non-201.
func (h *contractsHarness) create(token, address string, chainID, startBlock int64, label string) ContractResponse {
	h.t.Helper()

	body := fmt.Sprintf(`{"address":%q,"chainId":%d,"label":%q,"startBlock":%d}`,
		address, chainID, label, startBlock)

	rec := h.do(http.MethodPost, "/api/v1/contracts", body, token)
	if rec.Code != http.StatusCreated {
		h.t.Fatalf("create %s: expected 201, got %d body=%s", address, rec.Code, rec.Body.String())
	}

	var env ContractResponseEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		h.t.Fatalf("decode create envelope: %v", err)
	}
	return env.Data
}

func (h *contractsHarness) list(token, query string) ContractListEnvelope {
	h.t.Helper()

	rec := h.do(http.MethodGet, "/api/v1/contracts"+query, "", token)
	if rec.Code != http.StatusOK {
		h.t.Fatalf("list %q: expected 200, got %d body=%s", query, rec.Code, rec.Body.String())
	}

	var env ContractListEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		h.t.Fatalf("decode list envelope: %v", err)
	}
	return env
}

// contractAddr builds a distinct, well-formed address for each seed value.
func contractAddr(seed int) string {
	return fmt.Sprintf("0x%040x", seed)
}

// assertContractKeyset is the field-leak tripwire: exactly seven keys, no more.
func assertContractKeyset(t *testing.T, raw map[string]any) {
	t.Helper()

	allowed := map[string]bool{
		"id":         true,
		"address":    true,
		"chainId":    true,
		"label":      true,
		"enabled":    true,
		"startBlock": true,
		"createdAt":  true,
	}

	if len(raw) != len(allowed) {
		t.Fatalf("expected exactly %d keys in contract object, got %d: %v", len(allowed), len(raw), raw)
	}
	for k := range raw {
		if !allowed[k] {
			t.Fatalf("unexpected leaked key %q in contract object: %v", k, raw)
		}
	}
}

func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode string) {
	t.Helper()

	if rec.Code != wantStatus {
		t.Fatalf("expected %d, got %d body=%s", wantStatus, rec.Code, rec.Body.String())
	}

	var env ErrorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if env.Error.Code != wantCode {
		t.Fatalf("expected error code %s, got %s (body=%s)", wantCode, env.Error.Code, rec.Body.String())
	}
}

// assertValidationDetails pins the details shape: details carries the offending
// field. Used for both 422 domain rules and the 400 pagination caps, which also
// carry details.
func assertValidationDetails(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, field string) {
	t.Helper()

	assertErrorCode(t, rec, wantStatus, CodeValidationError)

	var env ErrorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if _, ok := env.Error.Details[field]; !ok {
		t.Fatalf("expected details key %q, got %v (body=%s)", field, env.Error.Details, rec.Body.String())
	}
}

// assertNoDetails pins the query-parse 400 shape: no details key at all.
func assertNoDetails(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()

	var raw struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if _, present := raw.Error["details"]; present {
		t.Fatalf("expected no details key, got body=%s", rec.Body.String())
	}
}

// 19. POST /api/v1/contracts
func TestCreateContractEndpoint(t *testing.T) {
	t.Run("201 with exact key set", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("creator@example.com")

		rec := h.do(http.MethodPost, "/api/v1/contracts",
			`{"address":"0xAbCdEf1234567890AbCdEf1234567890AbCdEf12","chainId":1,"label":"Treasury","startBlock":1234567}`,
			token)

		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
		}

		var env ContractResponseEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("decode envelope: %v", err)
		}
		if env.Data.ID <= 0 {
			t.Fatalf("expected a generated id > 0, got %d", env.Data.ID)
		}
		if env.Data.Address != "0xabcdef1234567890abcdef1234567890abcdef12" {
			t.Errorf("expected lowercased address, got %s", env.Data.Address)
		}
		if env.Data.ChainID != 1 || env.Data.StartBlock != 1234567 {
			t.Errorf("unexpected chainId/startBlock: %+v", env.Data)
		}
		if env.Data.Label != "Treasury" || !env.Data.Enabled {
			t.Errorf("unexpected label/enabled: %+v", env.Data)
		}
		if env.Data.CreatedAt.IsZero() {
			t.Error("expected non-zero createdAt")
		}

		// Envelope: exactly one key, "data".
		var topLevel map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &topLevel); err != nil {
			t.Fatalf("decode top level: %v", err)
		}
		if len(topLevel) != 1 {
			t.Fatalf("expected exactly 1 top-level key, got %d: %v", len(topLevel), topLevel)
		}
		if _, ok := topLevel["data"]; !ok {
			t.Fatalf("expected top-level data key, got %v", topLevel)
		}

		// Key-set tripwire on data.
		var raw struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatalf("decode raw data: %v", err)
		}
		assertContractKeyset(t, raw.Data)
	})

	t.Run("startBlock serializes as a JSON number", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("numbers@example.com")

		rec := h.do(http.MethodPost, "/api/v1/contracts",
			fmt.Sprintf(`{"address":%q,"chainId":1,"label":"Numbers","startBlock":9007199254740993}`, contractAddr(1)),
			token)
		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
		}

		var raw struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatalf("decode raw data: %v", err)
		}
		if _, isFloat := raw.Data["startBlock"].(float64); !isFloat {
			t.Fatalf("expected startBlock to be a JSON number, got %T (%v)", raw.Data["startBlock"], raw.Data["startBlock"])
		}
	})

	rejections := []struct {
		name           string
		body           string
		expectedStatus int
		expectedCode   string
		detailsField   string
	}{
		{"malformed JSON", `{"address":`, http.StatusBadRequest, CodeInvalidJSON, ""},
		{"empty body", " ", http.StatusBadRequest, CodeInvalidJSON, ""},
		{"unknown field", `{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"x","startBlock":0,"nickname":"leak"}`, http.StatusBadRequest, CodeInvalidJSON, ""},
		{"chainId as string", `{"address":"0x0000000000000000000000000000000000000001","chainId":"1","label":"x","startBlock":0}`, http.StatusBadRequest, CodeInvalidJSON, ""},
		{"startBlock as string", `{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"x","startBlock":"0"}`, http.StatusBadRequest, CodeInvalidJSON, ""},
		{"address too short", `{"address":"0x123","chainId":1,"label":"x","startBlock":0}`, http.StatusUnprocessableEntity, CodeValidationError, "address"},
		{"address missing 0x", `{"address":"abcdef1234567890abcdef1234567890abcdef12","chainId":1,"label":"x","startBlock":0}`, http.StatusUnprocessableEntity, CodeValidationError, "address"},
		{"address non-hex", `{"address":"0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ","chainId":1,"label":"x","startBlock":0}`, http.StatusUnprocessableEntity, CodeValidationError, "address"},
		{"negative startBlock", `{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"x","startBlock":-1}`, http.StatusUnprocessableEntity, CodeValidationError, "startBlock"},
		{"empty label", `{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"","startBlock":0}`, http.StatusUnprocessableEntity, CodeValidationError, "label"},
		{"whitespace label", `{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"   ","startBlock":0}`, http.StatusUnprocessableEntity, CodeValidationError, "label"},
		{"51-rune label", fmt.Sprintf(`{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":%q,"startBlock":0}`, strings.Repeat("a", 51)), http.StatusUnprocessableEntity, CodeValidationError, "label"},
		{"unsupported chain 999", `{"address":"0x0000000000000000000000000000000000000001","chainId":999,"label":"x","startBlock":0}`, http.StatusUnprocessableEntity, CodeValidationError, "chainId"},
		{"chainId 0", `{"address":"0x0000000000000000000000000000000000000001","chainId":0,"label":"x","startBlock":0}`, http.StatusUnprocessableEntity, CodeValidationError, "chainId"},
		{"chainId -5", `{"address":"0x0000000000000000000000000000000000000001","chainId":-5,"label":"x","startBlock":0}`, http.StatusUnprocessableEntity, CodeValidationError, "chainId"},
	}

	for _, tc := range rejections {
		t.Run(tc.name, func(t *testing.T) {
			h := newContractsHarness(t)
			token := h.token("rejections@example.com")

			rec := h.do(http.MethodPost, "/api/v1/contracts", tc.body, token)
			if rec.Code != tc.expectedStatus {
				t.Fatalf("expected %d, got %d body=%s", tc.expectedStatus, rec.Code, rec.Body.String())
			}

			var env ErrorEnvelope
			if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
				t.Fatalf("decode error envelope: %v", err)
			}
			if env.Error.Code != tc.expectedCode {
				t.Fatalf("expected error code %s, got %s", tc.expectedCode, env.Error.Code)
			}

			if tc.detailsField != "" {
				if _, ok := env.Error.Details[tc.detailsField]; !ok {
					t.Fatalf("expected details key %q, got %v", tc.detailsField, env.Error.Details)
				}
			}
		})
	}

	t.Run("no token is 401", func(t *testing.T) {
		h := newContractsHarness(t)

		rec := h.do(http.MethodPost, "/api/v1/contracts",
			`{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"x","startBlock":0}`, "")
		assertErrorCode(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
	})

	t.Run("bad token is 401", func(t *testing.T) {
		h := newContractsHarness(t)

		rec := h.do(http.MethodPost, "/api/v1/contracts",
			`{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"x","startBlock":0}`,
			"garbage-token")
		assertErrorCode(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
	})

	t.Run("logout revokes the token", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("revoked@example.com")

		if rec := h.do(http.MethodPost, "/api/v1/auth/logout", "", token); rec.Code != http.StatusOK {
			t.Fatalf("logout: expected 200, got %d body=%s", rec.Code, rec.Body.String())
		}

		rec := h.do(http.MethodPost, "/api/v1/contracts",
			`{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"x","startBlock":0}`, token)
		assertErrorCode(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
	})
}

// 20. Deployment reuse across users.
func TestCreateContractDeploymentReuse(t *testing.T) {
	h := newContractsHarness(t)
	tokenA := h.token("reuse-a@example.com")
	tokenB := h.token("reuse-b@example.com")

	addr := contractAddr(0x11)

	first := h.create(tokenA, addr, 1, 1000, "User A label")
	if first.StartBlock != 1000 {
		t.Fatalf("expected stored startBlock 1000, got %d", first.StartBlock)
	}

	t.Run("second user reuses the deployment and gets the stored startBlock", func(t *testing.T) {
		rec := h.do(http.MethodPost, "/api/v1/contracts",
			fmt.Sprintf(`{"address":%q,"chainId":1,"label":"User B label","startBlock":5000}`, strings.ToUpper(addr)),
			tokenB)
		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
		}

		var env ContractResponseEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("decode envelope: %v", err)
		}

		if env.Data.ID != first.ID {
			t.Errorf("expected the same deployment id %d, got %d", first.ID, env.Data.ID)
		}
		if env.Data.StartBlock != 1000 {
			t.Errorf("expected the stored startBlock 1000 to be echoed, got %d", env.Data.StartBlock)
		}
		if env.Data.Label != "User B label" {
			t.Errorf("expected B's own label, got %q", env.Data.Label)
		}
	})

	t.Run("both users appear in their own lists", func(t *testing.T) {
		if got := h.list(tokenA, "").Pagination.TotalItems; got != 1 {
			t.Errorf("expected A to see 1 tracking, got %d", got)
		}
		if got := h.list(tokenB, "").Pagination.TotalItems; got != 1 {
			t.Errorf("expected B to see 1 tracking, got %d", got)
		}
	})

	t.Run("duplicate tracking for the same user is 409", func(t *testing.T) {
		rec := h.do(http.MethodPost, "/api/v1/contracts",
			fmt.Sprintf(`{"address":%q,"chainId":1,"label":"Again","startBlock":1000}`, addr),
			tokenA)
		assertErrorCode(t, rec, http.StatusConflict, CodeResourceConflict)
	})

	t.Run("same address on another chain is a separate deployment", func(t *testing.T) {
		other := h.create(tokenA, addr, 137, 55, "Same address, chain 137")
		if other.ID == first.ID {
			t.Errorf("expected a distinct deployment for chain 137, both got id %d", other.ID)
		}
	})
}

// 21. GET /api/v1/contracts
func TestListContractsEndpoint(t *testing.T) {
	h := newContractsHarness(t)
	tokenA := h.token("list-a@example.com")
	tokenB := h.token("list-b@example.com")

	alpha := h.create(tokenA, contractAddr(0xaa01), 1, 10, "Alpha Vault")
	beta := h.create(tokenA, contractAddr(0xbb02), 137, 20, "Beta Pool")
	gamma := h.create(tokenA, contractAddr(0xcc03), 1, 30, "Gamma Swap")
	h.create(tokenB, contractAddr(0xdd04), 1, 40, "Delta Only")

	// Disable Gamma for the tri-state filter.
	rec := h.do(http.MethodPatch, fmt.Sprintf("/api/v1/contracts/%d", gamma.ID), `{"enabled":false}`, tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("setup disable: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	t.Run("scoping: A sees only A's trackings", func(t *testing.T) {
		env := h.list(tokenA, "")
		if env.Pagination.TotalItems != 3 || len(env.Data) != 3 {
			t.Fatalf("expected A to see 3, got %d (total %d)", len(env.Data), env.Pagination.TotalItems)
		}
		for _, c := range env.Data {
			if c.Label == "Delta Only" {
				t.Fatalf("A must not see B's tracking: %+v", c)
			}
		}

		if got := h.list(tokenB, "").Pagination.TotalItems; got != 1 {
			t.Errorf("expected B to see 1, got %d", got)
		}
	})

	t.Run("chainId filter", func(t *testing.T) {
		env := h.list(tokenA, "?chainId=1")
		if env.Pagination.TotalItems != 2 || len(env.Data) != 2 {
			t.Fatalf("expected 2 on chain 1, got %d (total %d)", len(env.Data), env.Pagination.TotalItems)
		}
		for _, c := range env.Data {
			if c.ChainID != 1 {
				t.Errorf("expected only chain 1, got %+v", c)
			}
		}

		env = h.list(tokenA, "?chainId=137")
		if env.Pagination.TotalItems != 1 || env.Data[0].ID != beta.ID {
			t.Errorf("expected only Beta Pool on chain 137, got %+v", env.Data)
		}
	})

	t.Run("enabled tri-state", func(t *testing.T) {
		if got := h.list(tokenA, "").Pagination.TotalItems; got != 3 {
			t.Errorf("absent enabled must not filter: got %d", got)
		}

		env := h.list(tokenA, "?enabled=true")
		if env.Pagination.TotalItems != 2 {
			t.Fatalf("expected 2 enabled, got %d", env.Pagination.TotalItems)
		}
		for _, c := range env.Data {
			if !c.Enabled {
				t.Errorf("expected only enabled records, got %+v", c)
			}
		}

		env = h.list(tokenA, "?enabled=false")
		if env.Pagination.TotalItems != 1 || env.Data[0].ID != gamma.ID {
			t.Errorf("expected only the disabled Gamma Swap, got %+v", env.Data)
		}
	})

	t.Run("enabled rejects anything but the exact literals", func(t *testing.T) {
		for _, q := range []string{"?enabled=banana", "?enabled=1", "?enabled=TRUE", "?enabled=", "?enabled=0", "?enabled=False"} {
			rec := h.do(http.MethodGet, "/api/v1/contracts"+q, "", tokenA)
			assertErrorCode(t, rec, http.StatusBadRequest, CodeValidationError)
			assertNoDetails(t, rec)
		}
	})

	t.Run("search matches label and address", func(t *testing.T) {
		env := h.list(tokenA, "?search=ALPHA")
		if env.Pagination.TotalItems != 1 || env.Data[0].ID != alpha.ID {
			t.Errorf("expected Alpha Vault via label search, got %+v", env.Data)
		}

		env = h.list(tokenA, fmt.Sprintf("?search=%s", strings.TrimPrefix(contractAddr(0xbb02), "0x")))
		if env.Pagination.TotalItems != 1 || env.Data[0].ID != beta.ID {
			t.Errorf("expected Beta Pool via address search, got %+v", env.Data)
		}
	})

	t.Run("non-integer pagination and chainId params are 400", func(t *testing.T) {
		for _, q := range []string{"?page=abc", "?pageSize=abc", "?chainId=abc", "?page=1.5"} {
			rec := h.do(http.MethodGet, "/api/v1/contracts"+q, "", tokenA)
			assertErrorCode(t, rec, http.StatusBadRequest, CodeValidationError)
			assertNoDetails(t, rec)
		}
	})

	t.Run("page and pageSize caps are 400 not 422", func(t *testing.T) {
		rec := h.do(http.MethodGet, "/api/v1/contracts?page=10001", "", tokenA)
		assertValidationDetails(t, rec, http.StatusBadRequest, "page")

		rec = h.do(http.MethodGet, "/api/v1/contracts?pageSize=101", "", tokenA)
		assertValidationDetails(t, rec, http.StatusBadRequest, "pageSize")
	})

	t.Run("chainId negative or unsupported is 422", func(t *testing.T) {
		for _, q := range []string{"?chainId=-5", "?chainId=999"} {
			rec := h.do(http.MethodGet, "/api/v1/contracts"+q, "", tokenA)
			assertValidationDetails(t, rec, http.StatusUnprocessableEntity, "chainId")
		}
	})

	t.Run("chainId 0 means unfiltered", func(t *testing.T) {
		env := h.list(tokenA, "?chainId=0")
		if env.Pagination.TotalItems != 3 {
			t.Errorf("expected chainId=0 to skip filtering, got total %d", env.Pagination.TotalItems)
		}
	})

	t.Run("pagination totals and past-last page", func(t *testing.T) {
		env := h.list(tokenA, "?page=1&pageSize=2")
		if len(env.Data) != 2 {
			t.Fatalf("expected 2 items on page 1, got %d", len(env.Data))
		}
		if env.Pagination.Page != 1 || env.Pagination.PageSize != 2 {
			t.Errorf("expected echoed page/pageSize 1/2, got %+v", env.Pagination)
		}
		if env.Pagination.TotalItems != 3 || env.Pagination.TotalPages != 2 {
			t.Errorf("expected totalItems 3 and totalPages 2, got %+v", env.Pagination)
		}

		env = h.list(tokenA, "?page=2&pageSize=2")
		if len(env.Data) != 1 {
			t.Fatalf("expected 1 item on page 2, got %d", len(env.Data))
		}

		env = h.list(tokenA, "?page=3&pageSize=2")
		if len(env.Data) != 0 {
			t.Errorf("expected an empty page past the last, got %d items", len(env.Data))
		}
		if env.Pagination.TotalItems != 3 {
			t.Errorf("expected totalItems to survive past the last page, got %d", env.Pagination.TotalItems)
		}
	})

	t.Run("list envelope key sets", func(t *testing.T) {
		rec := h.do(http.MethodGet, "/api/v1/contracts", "", tokenA)

		var raw struct {
			Data       []map[string]any `json:"data"`
			Pagination map[string]any   `json:"pagination"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatalf("decode raw list: %v", err)
		}

		for _, item := range raw.Data {
			assertContractKeyset(t, item)
		}

		allowedPagination := map[string]bool{"page": true, "pageSize": true, "totalItems": true, "totalPages": true}
		if len(raw.Pagination) != len(allowedPagination) {
			t.Fatalf("expected %d pagination keys, got %d: %v", len(allowedPagination), len(raw.Pagination), raw.Pagination)
		}
		for k := range raw.Pagination {
			if !allowedPagination[k] {
				t.Fatalf("unexpected pagination key %q", k)
			}
		}

		var topLevel map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &topLevel); err != nil {
			t.Fatalf("decode top level: %v", err)
		}
		if len(topLevel) != 2 {
			t.Fatalf("expected exactly data and pagination, got %v", topLevel)
		}
	})

	t.Run("empty result is an empty array not null", func(t *testing.T) {
		empty := h.token("list-empty@example.com")

		rec := h.do(http.MethodGet, "/api/v1/contracts", "", empty)

		var raw map[string]json.RawMessage
		if err := json.NewDecoder(rec.Body).Decode(&raw); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got := string(raw["data"]); got != "[]" {
			t.Fatalf("expected data:[], got data:%s", got)
		}
	})

	t.Run("no token is 401", func(t *testing.T) {
		rec := h.do(http.MethodGet, "/api/v1/contracts", "", "")
		assertErrorCode(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
	})
}

// 22. GET /api/v1/contracts/{id}
func TestGetContractEndpoint(t *testing.T) {
	h := newContractsHarness(t)
	owner := h.token("get-owner@example.com")
	stranger := h.token("get-stranger@example.com")

	created := h.create(owner, contractAddr(0x77), 11155111, 42, "Owner only")

	t.Run("owner gets 200 with the exact key set", func(t *testing.T) {
		rec := h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", created.ID), "", owner)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
		}

		var env ContractResponseEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if env.Data.ID != created.ID || env.Data.Label != "Owner only" || env.Data.StartBlock != 42 {
			t.Errorf("unexpected record: %+v", env.Data)
		}

		var raw struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatalf("decode raw data: %v", err)
		}
		assertContractKeyset(t, raw.Data)
	})

	t.Run("foreign and nonexistent are identical 404 bodies", func(t *testing.T) {
		foreign := h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", created.ID), "", stranger)
		missing := h.do(http.MethodGet, "/api/v1/contracts/999999", "", stranger)

		assertErrorCode(t, foreign, http.StatusNotFound, CodeResourceNotFound)
		assertErrorCode(t, missing, http.StatusNotFound, CodeResourceNotFound)

		// Oracle pin: the two responses must be byte-identical, so status alone
		// cannot distinguish "not yours" from "does not exist".
		if foreign.Body.String() != missing.Body.String() {
			t.Fatalf("expected identical bodies:\nforeign: %s\nmissing: %s", foreign.Body.String(), missing.Body.String())
		}
	})

	t.Run("invalid ids are 400", func(t *testing.T) {
		for _, id := range []string{"abc", "0", "-1", "1.5"} {
			rec := h.do(http.MethodGet, "/api/v1/contracts/"+id, "", owner)
			assertErrorCode(t, rec, http.StatusBadRequest, CodeValidationError)
			assertNoDetails(t, rec)
		}
	})

	t.Run("no token is 401", func(t *testing.T) {
		rec := h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", created.ID), "", "")
		assertErrorCode(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
	})
}

// 23. PATCH /api/v1/contracts/{id}
func TestUpdateContractEndpoint(t *testing.T) {
	t.Run("label-only, enabled-only, and all-nil", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("patch-owner@example.com")

		created := h.create(token, contractAddr(0x88), 1, 7, "Initial Label")
		path := fmt.Sprintf("/api/v1/contracts/%d", created.ID)

		rec := h.do(http.MethodPatch, path, `{"label":"Renamed"}`, token)
		if rec.Code != http.StatusOK {
			t.Fatalf("label-only: expected 200, got %d body=%s", rec.Code, rec.Body.String())
		}
		var env ContractResponseEnvelope
		json.Unmarshal(rec.Body.Bytes(), &env)
		if env.Data.Label != "Renamed" || !env.Data.Enabled {
			t.Errorf("label-only must preserve enabled: %+v", env.Data)
		}
		if !env.Data.CreatedAt.Equal(created.CreatedAt) {
			t.Errorf("label-only must preserve createdAt: %v vs %v", env.Data.CreatedAt, created.CreatedAt)
		}

		rec = h.do(http.MethodPatch, path, `{"enabled":false}`, token)
		if rec.Code != http.StatusOK {
			t.Fatalf("enabled-only: expected 200, got %d body=%s", rec.Code, rec.Body.String())
		}
		json.Unmarshal(rec.Body.Bytes(), &env)
		if env.Data.Label != "Renamed" || env.Data.Enabled {
			t.Errorf("enabled-only must preserve the label: %+v", env.Data)
		}

		before := env.Data
		rec = h.do(http.MethodPatch, path, `{}`, token)
		if rec.Code != http.StatusOK {
			t.Fatalf("all-nil: expected 200, got %d body=%s", rec.Code, rec.Body.String())
		}
		json.Unmarshal(rec.Body.Bytes(), &env)
		if env.Data.Label != before.Label || env.Data.Enabled != before.Enabled || !env.Data.CreatedAt.Equal(before.CreatedAt) {
			t.Errorf("all-nil must be a no-op: %+v vs %+v", env.Data, before)
		}

		// The no-op must not have written anything.
		rec = h.do(http.MethodGet, path, "", token)
		json.Unmarshal(rec.Body.Bytes(), &env)
		if env.Data.Label != before.Label || env.Data.Enabled != before.Enabled {
			t.Errorf("stored record changed after a no-op: %+v", env.Data)
		}
	})

	t.Run("label validation on update", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("patch-validation@example.com")

		created := h.create(token, contractAddr(0x89), 1, 7, "Keep me")
		path := fmt.Sprintf("/api/v1/contracts/%d", created.ID)

		for _, label := range []string{"", "   ", strings.Repeat("x", 51)} {
			rec := h.do(http.MethodPatch, path, fmt.Sprintf(`{"label":%q}`, label), token)
			assertValidationDetails(t, rec, http.StatusUnprocessableEntity, "label")
		}

		// A 50-rune unicode label must be accepted (rune cap, not byte cap).
		rec := h.do(http.MethodPatch, path, `{"label":"नमस्ते दुनिया नमस्ते नमस्ते दुनिया"}`, token)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected a 50-rune label to pass, got %d body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("unknown field is 400", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("patch-unknown@example.com")

		created := h.create(token, contractAddr(0x8a), 1, 7, "Label")
		rec := h.do(http.MethodPatch, fmt.Sprintf("/api/v1/contracts/%d", created.ID), `{"nickname":"leak"}`, token)
		assertErrorCode(t, rec, http.StatusBadRequest, CodeInvalidJSON)
	})

	t.Run("404 takes precedence over an invalid payload", func(t *testing.T) {
		h := newContractsHarness(t)
		owner := h.token("precedence-owner@example.com")
		stranger := h.token("precedence-stranger@example.com")

		created := h.create(owner, contractAddr(0x8b), 1, 7, "Owner record")

		rec := h.do(http.MethodPatch, fmt.Sprintf("/api/v1/contracts/%d", created.ID), `{"label":"   "}`, stranger)
		assertErrorCode(t, rec, http.StatusNotFound, CodeResourceNotFound)

		// and the owner's row is untouched
		rec = h.do(http.MethodGet, fmt.Sprintf("/api/v1/contracts/%d", created.ID), "", owner)
		var env ContractResponseEnvelope
		json.Unmarshal(rec.Body.Bytes(), &env)
		if env.Data.Label != "Owner record" {
			t.Errorf("foreign update must not change the row: %+v", env.Data)
		}
	})

	t.Run("malformed JSON is 400 for real and fake ids alike", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("patch-json@example.com")

		created := h.create(token, contractAddr(0x8c), 1, 7, "Label")

		real := h.do(http.MethodPatch, fmt.Sprintf("/api/v1/contracts/%d", created.ID), `{"label":`, token)
		fake := h.do(http.MethodPatch, "/api/v1/contracts/999999", `{"label":`, token)

		assertErrorCode(t, real, http.StatusBadRequest, CodeInvalidJSON)
		assertErrorCode(t, fake, http.StatusBadRequest, CodeInvalidJSON)

		// No existence oracle: the two bodies must be identical.
		if real.Body.String() != fake.Body.String() {
			t.Fatalf("expected identical bodies:\nreal: %s\nfake: %s", real.Body.String(), fake.Body.String())
		}
	})

	t.Run("invalid ids are 400 before the body is read", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("patch-ids@example.com")

		for _, id := range []string{"abc", "0", "-1"} {
			rec := h.do(http.MethodPatch, "/api/v1/contracts/"+id, `{"label":"x"}`, token)
			assertErrorCode(t, rec, http.StatusBadRequest, CodeValidationError)

			// Even with a malformed body, the id wins the ordering.
			rec = h.do(http.MethodPatch, "/api/v1/contracts/"+id, `{"label":`, token)
			assertErrorCode(t, rec, http.StatusBadRequest, CodeValidationError)
		}
	})

	t.Run("no token is 401", func(t *testing.T) {
		h := newContractsHarness(t)
		rec := h.do(http.MethodPatch, "/api/v1/contracts/1", `{"label":"x"}`, "")
		assertErrorCode(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
	})
}

// 24. DELETE /api/v1/contracts/{id}
func TestDeleteContractEndpoint(t *testing.T) {
	t.Run("204 with an empty body, then 404", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("delete-owner@example.com")

		created := h.create(token, contractAddr(0x99), 1, 7, "Doomed")
		path := fmt.Sprintf("/api/v1/contracts/%d", created.ID)

		rec := h.do(http.MethodDelete, path, "", token)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
		}
		if rec.Body.Len() != 0 {
			t.Fatalf("expected an empty body, got %q", rec.Body.String())
		}

		rec = h.do(http.MethodDelete, path, "", token)
		assertErrorCode(t, rec, http.StatusNotFound, CodeResourceNotFound)

		rec = h.do(http.MethodGet, path, "", token)
		assertErrorCode(t, rec, http.StatusNotFound, CodeResourceNotFound)
	})

	t.Run("foreign delete is 404 and leaves the record", func(t *testing.T) {
		h := newContractsHarness(t)
		owner := h.token("delete-a@example.com")
		stranger := h.token("delete-b@example.com")

		created := h.create(owner, contractAddr(0x9a), 1, 7, "Mine")
		path := fmt.Sprintf("/api/v1/contracts/%d", created.ID)

		rec := h.do(http.MethodDelete, path, "", stranger)
		assertErrorCode(t, rec, http.StatusNotFound, CodeResourceNotFound)

		rec = h.do(http.MethodGet, path, "", owner)
		if rec.Code != http.StatusOK {
			t.Fatalf("owner record must survive a foreign delete, got %d", rec.Code)
		}
	})

	t.Run("two users tracking one deployment: A deletes, B survives", func(t *testing.T) {
		h := newContractsHarness(t)
		tokenA := h.token("shared-a@example.com")
		tokenB := h.token("shared-b@example.com")

		addr := contractAddr(0x9b)
		recordA := h.create(tokenA, addr, 1, 100, "A tracking")
		recordB := h.create(tokenB, addr, 1, 5000, "B tracking")

		if recordA.ID != recordB.ID {
			t.Fatalf("expected one shared deployment, got %d and %d", recordA.ID, recordB.ID)
		}
		path := fmt.Sprintf("/api/v1/contracts/%d", recordA.ID)

		rec := h.do(http.MethodDelete, path, "", tokenA)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("A delete: expected 204, got %d body=%s", rec.Code, rec.Body.String())
		}

		rec = h.do(http.MethodGet, path, "", tokenA)
		assertErrorCode(t, rec, http.StatusNotFound, CodeResourceNotFound)

		rec = h.do(http.MethodGet, path, "", tokenB)
		if rec.Code != http.StatusOK {
			t.Fatalf("B tracking must survive A's delete, got %d body=%s", rec.Code, rec.Body.String())
		}

		var env ContractResponseEnvelope
		json.Unmarshal(rec.Body.Bytes(), &env)
		if env.Data.Label != "B tracking" || env.Data.StartBlock != 100 {
			t.Errorf("B must see its own record and the shared deployment: %+v", env.Data)
		}

		if got := h.list(tokenB, "").Pagination.TotalItems; got != 1 {
			t.Errorf("expected B to still list 1 tracking, got %d", got)
		}
	})

	t.Run("invalid ids are 400", func(t *testing.T) {
		h := newContractsHarness(t)
		token := h.token("delete-ids@example.com")

		for _, id := range []string{"abc", "0", "-1"} {
			rec := h.do(http.MethodDelete, "/api/v1/contracts/"+id, "", token)
			assertErrorCode(t, rec, http.StatusBadRequest, CodeValidationError)
		}
	})

	t.Run("no token is 401", func(t *testing.T) {
		h := newContractsHarness(t)
		rec := h.do(http.MethodDelete, "/api/v1/contracts/1", "", "")
		assertErrorCode(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
	})
}

func TestCurrentUser_IdenticalHouse401(t *testing.T) {
	chainSvc := chain.NewService(chain.NewInMemoryRepository())
	h := NewHandler(wallet.NewService(wallet.NewInMemoryWalletRepo(), chainSvc),
		user.NewService(user.NewInMemoryRepository()), chainSvc,
		contract.NewService(contract.NewInMemoryRepository(), chainSvc))

	rec := httptest.NewRecorder()
	u, ok := h.currentUser(rec, httptest.NewRequest(http.MethodGet, "/api/v1/contracts", nil))
	if ok || u != (user.User{}) {
		t.Fatalf("want ok=false with zero user, got ok=%t user=%+v", ok, u)
	}

	house := httptest.NewRecorder()
	writeError(house, http.StatusUnauthorized, CodeUnauthenticated, "unauthenticated", nil)
	if rec.Code != house.Code || rec.Body.String() != house.Body.String() {
		t.Fatalf("fallback must equal the house 401:\ngot  %d %s\nwant %d %s",
			rec.Code, rec.Body.String(), house.Code, house.Body.String())
	}
}
