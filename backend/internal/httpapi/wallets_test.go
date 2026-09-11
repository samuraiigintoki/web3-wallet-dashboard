package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func TestCreateWalletEndpoint(t *testing.T) {
	repo := wallet.NewInMemoryWalletRepo()
	svc := wallet.NewService(repo)
	router := NewRouter(svc)

	tests := []struct {
		name           string
		method         string
		path           string
		body           string
		expectedStatus int
		expectedCode   string
	}{
		{
			name: "happy path", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "   0x0000000000000000000000000000000000000001   ",
    			"chainId": 1,
    			"label": "  Primary Sepolia signer  "
				}`,
			expectedStatus: http.StatusCreated},
		{
			name: "malformed JSON", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001"`,
			expectedStatus: http.StatusBadRequest, expectedCode: CodeInvalidJSON},
		{
			name: "empty body", method: http.MethodPost, path: "/api/v1/wallets",
			body:           "",
			expectedStatus: http.StatusBadRequest, expectedCode: CodeInvalidJSON},
		{
			name: "unknown field", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
    			"chainId": 1,
    			"label": "Primary Sepolia signer",
				"nickname":"xpose gtaVI"
				}`,
			expectedStatus: http.StatusBadRequest, expectedCode: CodeInvalidJSON},
		{
			name: "chainId as string", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
    			"chainId": "1",
    			"label": "Primary Sepolia signer"
				}`,
			expectedStatus: http.StatusBadRequest, expectedCode: CodeInvalidJSON},
		{
			name: "address wrong length", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x12345678",
    			"chainId": 1,
    			"label": "Primary Sepolia signer"
				}`,
			expectedStatus: http.StatusUnprocessableEntity,
			expectedCode:   CodeValidationError},
		{
			name: "address missing 0x prefix", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "ab0000000000000000000000000000000000000001",
    			"chainId": 1,
    			"label": "Primary Sepolia signer"
				}`,
			expectedStatus: http.StatusUnprocessableEntity,
			expectedCode:   CodeValidationError},
		{
			name: "empty label", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
    			"chainId": 1,
    			"label": ""
				}`,
			expectedStatus: http.StatusUnprocessableEntity,
			expectedCode:   CodeValidationError},
		{
			name: "40 unicode character string", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000012",
    			"chainId": 1,
    			"label": "नमस्तेनमस्तेनमस्तेनमस्तेनमस्तेनमस्तेनमस्तेनमस्ते"
				}`,
			expectedStatus: http.StatusCreated},
		{
			name: "label over 50 character", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
    			"chainId": 1,
    			"label": "MyPersonalPrimarySecureHotWalletAccountIdentifierExceeds51Characters"
				}`,
			expectedStatus: http.StatusUnprocessableEntity,
			expectedCode:   CodeValidationError},
		{
			name: "oversized body", method: http.MethodPost, path: "/api/v1/wallets",
			body:           strings.Repeat("a", 1<<20+100),
			expectedStatus: http.StatusBadRequest, expectedCode: CodeInvalidJSON},
		{
			name: "list empty", method: http.MethodGet, path: "/api/v1/wallets",
			body:           "",
			expectedStatus: http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body))
			rec := httptest.NewRecorder()

			router.ServeHTTP(rec, req)

			if rec.Code != tt.expectedStatus {
				t.Fatalf("expected status= %d, got = %d", rec.Code, tt.expectedStatus)
			}

			if tt.expectedStatus != http.StatusMethodNotAllowed {
				expectedType := "application/json"
				if ct := rec.Header().Get("Content-Type"); ct != expectedType {
					t.Errorf("Expected Content-type = %q; got = %q", expectedType, ct)
				}
			}

			if tt.name == "happy path" {
				var res WalletResponseEnvelope
				if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
					t.Fatalf("failed to decode body: %v", err)
				}
				if res.Data.Address != "0x0000000000000000000000000000000000000001" {
					t.Errorf("expected trimmed address, got %q", res.Data.Address)
				}
				if res.Data.Label != "Primary Sepolia signer" {
					t.Errorf("expected trimmed label, got %q", res.Data.Label)
				}
			}

			if tt.expectedCode != "" {
				var errRes *ErrorEnvelope
				if err := json.NewDecoder(rec.Body).Decode(&errRes); err != nil {
					t.Fatalf("failed to decode error body: %v", err)
				}

				if errRes.Error.Code != tt.expectedCode {
					t.Errorf("expected code = %q; got = %q", tt.expectedCode, errRes.Error.Code)
				}

				if tt.expectedStatus == http.StatusUnprocessableEntity && len(errRes.Error.Details) == 0 {
					t.Errorf("expected details to be populated for 422 error")
				}
			}
		})
	}
}

func TestGetWalletEndpoint(t *testing.T) {
	repo := wallet.NewInMemoryWalletRepo()
	svc := wallet.NewService(repo)
	router := NewRouter(svc)

	seedWallet := `{"address":"0x0000000000000000000000000000000000000001","chainId":1,"label":"seed Wallet"}`

	postReq, err := http.NewRequest(http.MethodPost, "/api/v1/wallets", strings.NewReader(seedWallet))
	if err != nil {
		t.Fatalf("failed to create seed request: %v", err)
	}

	postReq.Header.Set("Content-Type", "application/json")

	seedRec := httptest.NewRecorder()
	router.ServeHTTP(seedRec, postReq)
	if seedRec.Code != http.StatusCreated {
		t.Fatalf("failed to create wallet, expected: %d, got: %d", http.StatusCreated, seedRec.Code)
	}

	tests := []struct {
		name           string
		path           string
		expectedStatus int
		expectedCode   string
		isHappyPath    bool
	}{
		{
			name:           "happy path",
			path:           "/api/v1/wallets/1",
			expectedStatus: http.StatusOK,
			expectedCode:   "",
			isHappyPath:    true,
		},
		{
			name:           "non-existent ID",
			path:           "/api/v1/wallets/999",
			expectedStatus: http.StatusNotFound,
			expectedCode:   CodeResourceNotFound,
			isHappyPath:    false,
		},
		{
			name:           "invalid non-numeric ID",
			path:           "/api/v1/wallets/abc",
			expectedStatus: http.StatusBadRequest,
			expectedCode:   CodeValidationError,
			isHappyPath:    false,
		},
		{
			name:           "negative ID",
			path:           "/api/v1/wallets/-1",
			expectedStatus: http.StatusBadRequest,
			expectedCode:   CodeValidationError,
			isHappyPath:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, tt.path, nil)
			if err != nil {
				t.Fatalf("Failed to create GET request: %v", err)
			}

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tt.expectedStatus {
				t.Errorf("Expected status %d, got %d", tt.expectedStatus, rec.Code)
			}

			if tt.isHappyPath && rec.Code == http.StatusOK {
				var res WalletResponseEnvelope
				if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
					t.Fatalf("Failed to decode response body: %v", err)
				}

				if res.Data.ID != 1 {
					t.Errorf("Expected wallet ID to be 1, got %d", res.Data.ID)
				}
			}

			if !tt.isHappyPath && tt.expectedCode != "" {
				var errRes ErrorEnvelope
				if err := json.NewDecoder(rec.Body).Decode(&errRes); err != nil {
					t.Fatalf("Failed to decode error body: %v", err)
				}
				if errRes.Error.Code != tt.expectedCode {
					t.Errorf("Expected error code %q, got %q", tt.expectedCode, errRes.Error.Code)
				}
			}
		})
	}
}

func TestListWalletsEndpoint(t *testing.T) {
	repo := wallet.NewInMemoryWalletRepo()
	svc := wallet.NewService(repo)
	router := NewRouter(svc)

	// case 1: empty list (no seed)
	{
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected code: %d, got: %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Failed to decode response body: %v", err)
		}

		if len(res.Data) != 0 {
			t.Errorf("expected len(res.Data) to be 0, got %d", len(res.Data))
		}

		if res.Pagination.Page != 1 {
			t.Errorf("expected res.Pagination.Page to be 1, got %d", res.Pagination.Page)
		}

		if res.Pagination.PageSize != 20 {
			t.Errorf("expected res.Pagination.PageSize to be 20, got %d", res.Pagination.PageSize)
		}

		if res.Pagination.TotalItems != 0 {
			t.Errorf("expected res.Pagination.TotalItems to be 0, got %d", res.Pagination.TotalItems)
		}

		if res.Pagination.TotalPages != 0 {
			t.Errorf("expected res.Pagination.TotalPages to be 0, got %d", res.Pagination.TotalPages)
		}
	}

	// case 2 bad path (no seed)
	{
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?page=abc", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected status code %d, got %d", http.StatusBadRequest, rec.Code)
		}

		var errRes ErrorEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&errRes); err != nil {
			t.Fatalf("failed to decode response body: %v", err)
		}

		if errRes.Error.Code != CodeValidationError {
			t.Errorf("expected error code: %s, got: %s", CodeValidationError, errRes.Error.Code)
		}
	}

	// case 3: cases that needs data (table driven)
	{
		seedA := `{"address":"0x00000000000000000000000000000000000000aa","chainId":1,"label":"alpha wallet"}`
		postReq := httptest.NewRequest(http.MethodPost, "/api/v1/wallets", strings.NewReader(seedA))
		postReq.Header.Set("Content-Type", "application/json")

		postRec := httptest.NewRecorder()

		router.ServeHTTP(postRec, postReq)

		if postRec.Code != http.StatusCreated {
			t.Fatalf("expected status code:%d, got:%d", http.StatusCreated, postRec.Code)
		}

		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected code :%d, got :%d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("failed to decode response body: %v", err)
		}

		if len(res.Data) != 1 {
			t.Errorf("expected len(res.Data) to be 1, got: %d", len(res.Data))
		} else if res.Data[0].Address != "0x00000000000000000000000000000000000000aa" {
			t.Errorf("expected address to be ...aa, got:%s", res.Data[0].Address)
		}

		if res.Pagination.Page != 1 {
			t.Errorf("expected res.Pagination.Page to be 1, got:%d", res.Pagination.Page)
		}

		if res.Pagination.PageSize != 20 {
			t.Errorf("expected res.Pagination.PageSize to be 20, got: %d", res.Pagination.PageSize)
		}

		if res.Pagination.TotalItems != 1 {
			t.Errorf("expected res.Pagination.TotalItems to be 1, got:%d", res.Pagination.TotalItems)
		}

		if res.Pagination.TotalPages != 1 {
			t.Errorf("expected res.Pagination.TotalPages to be 1, got:%d", res.Pagination.TotalPages)
		}

	}

	// case 4: page size 1 page 1 (Seed A + B)
	{
		// 1. POST seed B
		seedB := `{"address":"0x00000000000000000000000000000000000000bb","chainId":1,"label":"beta search-hit"}`
		postReq := httptest.NewRequest(http.MethodPost, "/api/v1/wallets", strings.NewReader(seedB))
		postReq.Header.Set("Content-Type", "application/json")
		postRec := httptest.NewRecorder()

		router.ServeHTTP(postRec, postReq)
		if postRec.Code != http.StatusCreated {
			t.Fatalf("seeding failed: expected status code %d, got %d", http.StatusCreated, postRec.Code)
		}

		// 2. GET page=1&pageSize=1
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?page=1&pageSize=1", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("Case 4: expected status code %d, got %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Case 4: failed to decode response body: %v", err)
		}

		if len(res.Data) != 1 {
			t.Errorf("Case 4: expected len(res.Data) to be 1, got %d", len(res.Data))
		} else if res.Data[0].Address != "0x00000000000000000000000000000000000000bb" {
			t.Errorf("Case 4: expected address to be ...bb, got %s", res.Data[0].Address)
		}

		if res.Pagination.TotalItems != 2 || res.Pagination.TotalPages != 2 {
			t.Errorf("Case 4: expected totalItems=2, totalPages=2; got totalItems=%d, totalPages=%d", res.Pagination.TotalItems, res.Pagination.TotalPages)
		}
	}

	// Case 5: page size 1 page 2 (Seed A + B)
	{
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?page=2&pageSize=1", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("Case 5: expected status code %d, got %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Case 5: failed to decode response body: %v", err)
		}

		if len(res.Data) != 1 {
			t.Errorf("Case 5: expected len(res.Data) to be 1, got %d", len(res.Data))
		} else if res.Data[0].Address != "0x00000000000000000000000000000000000000aa" {
			t.Errorf("Case 5: expected address to be ...aa, got %s", res.Data[0].Address)
		}
	}

	// Case 6: filter chain 137 (Seed A + B + C)
	{
		// 1. POST seed C (Chain 137)
		seedC := `{"address":"0x00000000000000000000000000000000000000cc","chainId":137,"label":"polygon only"}`
		postReq := httptest.NewRequest(http.MethodPost, "/api/v1/wallets", strings.NewReader(seedC))
		postReq.Header.Set("Content-Type", "application/json")
		postRec := httptest.NewRecorder()

		router.ServeHTTP(postRec, postReq)
		if postRec.Code != http.StatusCreated {
			t.Fatalf("Case 6: seeding failed: expected status code %d, got %d", http.StatusCreated, postRec.Code)
		}

		// 2. GET chainId=137
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?chainId=137", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("Case 6: expected status code %d, got %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Case 6: failed to decode response body: %v", err)
		}

		if len(res.Data) != 1 {
			t.Errorf("Case 6: expected len(res.Data) to be 1, got %d", len(res.Data))
		} else if res.Data[0].Address != "0x00000000000000000000000000000000000000cc" {
			t.Errorf("Case 6: expected address to be ...cc, got %s", res.Data[0].Address)
		}
	}

}
