package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func TestCreateWalletEndpoint(t *testing.T) {
	walletRepo := wallet.NewInMemoryWalletRepo()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(walletRepo, chainSvc)

	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)

	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

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
	walletRepo := wallet.NewInMemoryWalletRepo()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(walletRepo, chainSvc)

	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)

	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

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
	walletRepo := wallet.NewInMemoryWalletRepo()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainRepo.Seed(chain.Chain{ChainID: 11155111, Name: "Sepolia", Symbol: "ETH", Enabled: true})
	chainRepo.Seed(chain.Chain{ChainID: 137, Name: "Polygon", Symbol: "POL", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(walletRepo, chainSvc)

	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)

	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

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

	// case 7: testing path /api/v1/wallets?page=-5
	{
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?page=-5", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("Case 7: expected status code %d, got %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Case 7: failed to decode response body: %v", err)
		}

		if len(res.Data) == 0 {
			t.Errorf("Case 7: expected len(res.Data) to be greater than 0, got %d", len(res.Data))
		}

		if res.Pagination.Page != 1 {
			t.Errorf("Case 7: expected res.Pagination.Page to be 1, got: %d", res.Pagination.Page)
		}
	}

	// case 8: testing path /api/v1/wallets?pageSize=-5
	{
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?pageSize=-5", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("Case 8: expected status code %d, got %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Case 8: failed to decode response body: %v", err)
		}

		if res.Pagination.PageSize != 20 {
			t.Errorf("Case 8: expected res.Pagination.PageSize to be 20, got: %d", res.Pagination.PageSize)
		}

		if res.Pagination.TotalPages == 0 {
			t.Errorf("Case 8: expected res.Pagination.TotalPages not to be 0, got:%d", res.Pagination.TotalPages)
		}
	}

	// case 9: testing path /api/v1/wallets?page=0
	{
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?page=0", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("Case 9: expected status code %d, got %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Case 9: failed to decode response body: %v", err)
		}

		if res.Pagination.Page != 1 {
			t.Errorf("Case 9: expected res.Pagination.Page to be 1, got:%d", res.Pagination.Page)
		}
	}

	// case 10: testing path /api/v1/wallets?chainId=0
	{
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?chainId=0", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("Case 10: expected status code %d, got %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Case 10: failed to decode response body: %v", err)
		}

		if len(res.Data) < 3 {
			t.Errorf("Case 10: expected at least 3 wallets, got:%d", len(res.Data))
		}
	}

	// case 11: testing path /api/v1/wallets?search=search-hit
	{
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?search=search-hit", nil)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("Case 11: expected status code %d, got %d", http.StatusOK, rec.Code)
		}

		var res WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatalf("Case 11: failed to decode response body: %v", err)
		}

		if len(res.Data) != 1 {
			t.Errorf("Case 11: expected exactly 1 wallet, got : %d", len(res.Data))
		} else if res.Data[0].Address != "0x00000000000000000000000000000000000000bb" {
			t.Errorf("Case 11: expected res.Data[0].Address to be ...bb , got: %s", res.Data[0].Address)
		}
	}
}

func TestUpdateWallet(t *testing.T) {

	t.Run("updates label and preserves createdAt", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		created := seedWallet(t, router, "0x0000000000000000000000000000000000000001")

		createdAtBefore := created.Data.CreatedAt
		target := "/api/v1/wallets/" + strconv.Itoa(int(created.Data.ID))

		// PATCH: change the label
		patchBody := `{"label":"new label"}`
		patchReq, err := http.NewRequest(http.MethodPatch, target, strings.NewReader(patchBody))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusOK {
			t.Fatalf("expected: %d, got: %d", http.StatusOK, patchRec.Code)
		}

		var updated WalletResponseEnvelope
		if err := json.NewDecoder(patchRec.Body).Decode(&updated); err != nil {
			t.Fatalf("failed to decode patch response body: %v", err)
		}
		if updated.Data.Label != "new label" {
			t.Fatalf("expected label 'new label', got: %s", updated.Data.Label)
		}
		if !updated.Data.CreatedAt.Equal(createdAtBefore) {
			t.Fatalf("expected createdAt %v, got %v", createdAtBefore, updated.Data.CreatedAt)
		}

		// Probe: GET through a different path to confirm storage actually changed
		getReq, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("failed to create get request: %v", err)
		}

		getRec := httptest.NewRecorder()
		router.ServeHTTP(getRec, getReq)
		if getRec.Code != http.StatusOK {
			t.Fatalf("failed to fetch after update, expected: %d, got: %d", http.StatusOK, getRec.Code)
		}

		var fetched WalletResponseEnvelope
		if err := json.NewDecoder(getRec.Body).Decode(&fetched); err != nil {
			t.Fatalf("failed to decode get response body: %v", err)
		}
		if fetched.Data.Label != "new label" {
			t.Fatalf("label not persisted after update, got: %s", fetched.Data.Label)
		}
	})

	t.Run("null label is treated as absent", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		created := seedWallet(t, router, "0x0000000000000000000000000000000000000001")

		createdAtBefore := created.Data.CreatedAt
		target := "/api/v1/wallets/" + strconv.Itoa(int(created.Data.ID))

		patchBody := `{"label":null}`
		patchReq, err := http.NewRequest(http.MethodPatch, target, strings.NewReader(patchBody))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusOK {
			t.Fatalf("expected: %d, got: %d", http.StatusOK, patchRec.Code)
		}

		var updated WalletResponseEnvelope
		if err := json.NewDecoder(patchRec.Body).Decode(&updated); err != nil {
			t.Fatalf("failed to decode patch response body: %v", err)
		}
		if updated.Data.Label != "seed Wallet" {
			t.Fatalf("expected label to stay 'seed Wallet', got: %s", updated.Data.Label)
		}
		if !updated.Data.CreatedAt.Equal(createdAtBefore) {
			t.Fatalf("expected createdAt %v, got %v", createdAtBefore, updated.Data.CreatedAt)
		}
	})

	t.Run("no-op when label absent", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		created := seedWallet(t, router, "0x0000000000000000000000000000000000000001")

		createdAtBefore := created.Data.CreatedAt
		target := "/api/v1/wallets/" + strconv.Itoa(int(created.Data.ID))

		patchBody := "{}"
		patchReq, err := http.NewRequest(http.MethodPatch, target, strings.NewReader(patchBody))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusOK {
			t.Fatalf("expected: %d, got: %d", http.StatusOK, patchRec.Code)
		}

		var updated WalletResponseEnvelope
		if err := json.NewDecoder(patchRec.Body).Decode(&updated); err != nil {
			t.Fatalf("failed to decode patch response body: %v", err)
		}
		if updated.Data.Label != "seed Wallet" {
			t.Fatalf("expected label to stay 'seed Wallet', got: %s", updated.Data.Label)
		}
		if !updated.Data.CreatedAt.Equal(createdAtBefore) {
			t.Fatalf("expected createdAt %v, got %v", createdAtBefore, updated.Data.CreatedAt)
		}
	})

	t.Run("whitespace label returns 422", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		created := seedWallet(t, router, "0x0000000000000000000000000000000000000001")

		target := "/api/v1/wallets/" + strconv.Itoa(int(created.Data.ID))
		patchBody := `{"label":"   "}`

		patchReq, err := http.NewRequest(http.MethodPatch, target, strings.NewReader(patchBody))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("expected: %d, got: %d", http.StatusUnprocessableEntity, patchRec.Code)
		}

		var errRes ErrorEnvelope
		if err := json.NewDecoder(patchRec.Body).Decode(&errRes); err != nil {
			t.Fatalf("failed to decode patch response body: %v", err)
		}
		if errRes.Error.Code != CodeValidationError {
			t.Fatalf("expected error code %q, got %q", CodeValidationError, errRes.Error.Code)
		}

	})

	t.Run("missing id returns 404", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		// no seed => id 999999 never existed
		patchBody := `{"label":"x"}`
		patchReq, err := http.NewRequest(http.MethodPatch, "/api/v1/wallets/999999", strings.NewReader(patchBody))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusNotFound {
			t.Fatalf("expected: %d, got: %d", http.StatusNotFound, patchRec.Code)
		}

		var errRes ErrorEnvelope
		if err := json.NewDecoder(patchRec.Body).Decode(&errRes); err != nil {
			t.Fatalf("failed to decode patch response body: %v", err)
		}
		if errRes.Error.Code != CodeResourceNotFound {
			t.Fatalf("expected error code %q, got %q", CodeResourceNotFound, errRes.Error.Code)
		}
	})

	t.Run("invalid id returns 400", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		patchBody := `{"label":"x"}`
		patchReq, err := http.NewRequest(http.MethodPatch, "/api/v1/wallets/abc", strings.NewReader(patchBody))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusBadRequest {
			t.Fatalf("expected: %d, got: %d", http.StatusBadRequest, patchRec.Code)
		}

		var errRes ErrorEnvelope
		if err := json.NewDecoder(patchRec.Body).Decode(&errRes); err != nil {
			t.Fatalf("failed to decode patch response body: %v", err)
		}
		if errRes.Error.Code != CodeValidationError {
			t.Fatalf("expected error code %q, got %q", CodeValidationError, errRes.Error.Code)
		}
	})

	t.Run("unknown field returns 400", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		created := seedWallet(t, router, "0x0000000000000000000000000000000000000001")
		target := "/api/v1/wallets/" + strconv.Itoa(int(created.Data.ID))

		patchBody := `{"foo":"bar"}`
		patchReq, err := http.NewRequest(http.MethodPatch, target, strings.NewReader(patchBody))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusBadRequest {
			t.Fatalf("expected: %d, got: %d", http.StatusBadRequest, patchRec.Code)
		}

		var errRes ErrorEnvelope
		if err := json.NewDecoder(patchRec.Body).Decode(&errRes); err != nil {
			t.Fatalf("failed to decode patch response body: %v", err)
		}
		if errRes.Error.Code != CodeInvalidJSON {
			t.Fatalf("expected error code %q, got %q", CodeInvalidJSON, errRes.Error.Code)
		}
	})

	t.Run("empty body returns 400", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		created := seedWallet(t, router, "0x0000000000000000000000000000000000000001")
		target := "/api/v1/wallets/" + strconv.Itoa(int(created.Data.ID))

		patchReq, err := http.NewRequest(http.MethodPatch, target, strings.NewReader(""))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusBadRequest {
			t.Fatalf("expected: %d, got: %d", http.StatusBadRequest, patchRec.Code)
		}

		var errRes ErrorEnvelope
		if err := json.NewDecoder(patchRec.Body).Decode(&errRes); err != nil {
			t.Fatalf("failed to decode patch response body: %v", err)
		}
		if errRes.Error.Code != CodeInvalidJSON {
			t.Fatalf("expected error code %q, got %q", CodeInvalidJSON, errRes.Error.Code)
		}
	})

	t.Run("updates only the target row", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		first := seedWallet(t, router, "0x0000000000000000000000000000000000000001")
		second := seedWallet(t, router, "0x0000000000000000000000000000000000000002")

		targetSecond := "/api/v1/wallets/" + strconv.Itoa(int(second.Data.ID))
		patchBody := `{"label":"new label"}`
		patchReq, err := http.NewRequest(http.MethodPatch, targetSecond, strings.NewReader(patchBody))
		if err != nil {
			t.Fatalf("failed to create patch request: %v", err)
		}
		patchReq.Header.Set("Content-Type", "application/json")

		patchRec := httptest.NewRecorder()
		router.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusOK {
			t.Fatalf("expected: %d, got: %d", http.StatusOK, patchRec.Code)
		}

		// Probe: fetch the FIRST wallet through a separate GET — it must be untouched
		targetFirst := "/api/v1/wallets/" + strconv.Itoa(int(first.Data.ID))
		getReq, err := http.NewRequest(http.MethodGet, targetFirst, nil)
		if err != nil {
			t.Fatalf("failed to create get request: %v", err)
		}

		getRec := httptest.NewRecorder()
		router.ServeHTTP(getRec, getReq)
		if getRec.Code != http.StatusOK {
			t.Fatalf("expected: %d, got: %d", http.StatusOK, getRec.Code)
		}

		var fetched WalletResponseEnvelope
		if err := json.NewDecoder(getRec.Body).Decode(&fetched); err != nil {
			t.Fatalf("failed to decode get response body: %v", err)
		}
		if fetched.Data.Label != "seed Wallet" {
			t.Fatalf("expected first wallet's label to stay 'seed Wallet', got: %s", fetched.Data.Label)
		}
	})

}

func TestDeleteWallet(t *testing.T) {

	t.Run("returns 204 with empty body", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		created := seedWallet(t, router, "0x0000000000000000000000000000000000000001")

		target := "/api/v1/wallets/" + strconv.Itoa(int(created.Data.ID))

		delReq, err := http.NewRequest(http.MethodDelete, target, nil)
		if err != nil {
			t.Fatalf("failed to create delete request: %v", err)
		}

		delRec := httptest.NewRecorder()
		router.ServeHTTP(delRec, delReq)
		if delRec.Code != http.StatusNoContent {
			t.Fatalf("expected: %d, got: %d", http.StatusNoContent, delRec.Code)
		}
		if delRec.Body.Len() != 0 {
			t.Fatalf("expected empty body, got: %q", delRec.Body.String())
		}

		getReq, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("failed to create get request: %v", err)
		}

		getRec := httptest.NewRecorder()
		router.ServeHTTP(getRec, getReq)
		if getRec.Code != http.StatusNotFound {
			t.Fatalf("expected: %d, got: %d", http.StatusNotFound, getRec.Code)
		}
	})

	t.Run("second delete returns 404", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		created := seedWallet(t, router, "0x0000000000000000000000000000000000000001")

		target := "/api/v1/wallets/" + strconv.Itoa(int(created.Data.ID))

		firstDelReq, err := http.NewRequest(http.MethodDelete, target, nil)
		if err != nil {
			t.Fatalf("failed to create first delete request: %v", err)
		}
		firstDelRec := httptest.NewRecorder()
		router.ServeHTTP(firstDelRec, firstDelReq)
		if firstDelRec.Code != http.StatusNoContent {
			t.Fatalf("expected: %d, got: %d", http.StatusNoContent, firstDelRec.Code)
		}

		secondDelReq, err := http.NewRequest(http.MethodDelete, target, nil)
		if err != nil {
			t.Fatalf("failed to create second delete request: %v", err)
		}
		secondDelRec := httptest.NewRecorder()
		router.ServeHTTP(secondDelRec, secondDelReq)
		if secondDelRec.Code != http.StatusNotFound {
			t.Fatalf("expected: %d, got: %d", http.StatusNotFound, secondDelRec.Code)
		}

		var errRes ErrorEnvelope
		if err := json.NewDecoder(secondDelRec.Body).Decode(&errRes); err != nil {
			t.Fatalf("failed to decode error response body: %v", err)
		}
		if errRes.Error.Code != CodeResourceNotFound {
			t.Fatalf("expected error code %q, got %q", CodeResourceNotFound, errRes.Error.Code)
		}
	})

	t.Run("invalid id returns 400", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()

		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
		chainSvc := chain.NewService(chainRepo)

		walletSvc := wallet.NewService(walletRepo, chainSvc)

		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)

		contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

		router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

		delReq, err := http.NewRequest(http.MethodDelete, "/api/v1/wallets/abc", nil)
		if err != nil {
			t.Fatalf("failed to create delete request: %v", err)
		}

		delRec := httptest.NewRecorder()
		router.ServeHTTP(delRec, delReq)
		if delRec.Code != http.StatusBadRequest {
			t.Fatalf("expected: %d, got: %d", http.StatusBadRequest, delRec.Code)
		}

		var errRes ErrorEnvelope
		if err := json.NewDecoder(delRec.Body).Decode(&errRes); err != nil {
			t.Fatalf("failed to decode error response body: %v", err)
		}
		if errRes.Error.Code != CodeValidationError {
			t.Fatalf("expected error code %q, got %q", CodeValidationError, errRes.Error.Code)
		}
	})
}

func TestCreateWallet_UnsupportedChain_DetailsMap(t *testing.T) {
	walletRepo := wallet.NewInMemoryWalletRepo()
	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(
		chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true},
		chain.Chain{ChainID: 137, Name: "Polygon", Symbol: "POL", Enabled: true},
		chain.Chain{ChainID: 11155111, Name: "Sepolia", Symbol: "ETH", Enabled: true},
	)
	chainSvc := chain.NewService(chainRepo)
	walletSvc := wallet.NewService(walletRepo, chainSvc)
	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)
	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

	body := `{"address":"0x0000000000000000000000000000000000000099","chainId":999999,"label":"bad chain"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/wallets", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d", rec.Code)
	}

	var resp ErrorEnvelope
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Error.Details["chainId"] != "unsupported chain id" {
		t.Fatalf("expected error.details.chainId='unsupported chain id', got %q", resp.Error.Details["chainId"])
	}
}

func TestListWallets_ChainFilterTrio(t *testing.T) {
	walletRepo := wallet.NewInMemoryWalletRepo()
	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(
		chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true},
		chain.Chain{ChainID: 137, Name: "Polygon", Symbol: "POL", Enabled: true},
		chain.Chain{ChainID: 11155111, Name: "Sepolia", Symbol: "ETH", Enabled: true},
	)
	chainSvc := chain.NewService(chainRepo)
	walletSvc := wallet.NewService(walletRepo, chainSvc)
	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)
	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := newAuthedRouter(t, walletSvc, userSvc, chainSvc, contractSvc)

	// Seed one wallet on chain 1 and one on chain 137
	seedWalletOnChain := func(t *testing.T, addr string, chainID int64) {
		t.Helper()
		b := `{"address":"` + addr + `","chainId":` + strconv.FormatInt(chainID, 10) + `,"label":"test"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/wallets", strings.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("seed wallet %s on chain %d: expected 201, got %d", addr, chainID, rec.Code)
		}
	}

	seedWalletOnChain(t, "0x0000000000000000000000000000000000000001", 1)
	seedWalletOnChain(t, "0x0000000000000000000000000000000000000137", 137)

	t.Run("unsupported chainId returns 422 with details", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?chainId=999999", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("expected 422, got %d", rec.Code)
		}

		var resp ErrorEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if resp.Error.Details["chainId"] != "unsupported chain id" {
			t.Fatalf("expected error.details.chainId='unsupported chain id', got %q", resp.Error.Details["chainId"])
		}
	})

	t.Run("supported chainId filters correctly", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?chainId=137", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}

		var body WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}

		if len(body.Data) == 0 {
			t.Fatal("expected at least one wallet on chain 137")
		}
		for _, w := range body.Data {
			if w.ChainID != 137 {
				t.Fatalf("expected all wallets chainId=137, got %d", w.ChainID)
			}
		}
	})

	t.Run("chainId=0 returns unfiltered list", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets?chainId=0", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}

		var body WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}

		if len(body.Data) < 2 {
			t.Fatalf("expected at least 2 wallets unfiltered, got %d", len(body.Data))
		}

		seen := map[int64]bool{}
		for _, w := range body.Data {
			seen[w.ChainID] = true
		}
		if !seen[1] || !seen[137] {
			t.Fatalf("expected mixed chain ids, got %v", seen)
		}
	})

	t.Run("no chainId param returns unfiltered list", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}

		var body WalletListEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}

		if len(body.Data) < 2 {
			t.Fatalf("expected at least 2 wallets unfiltered, got %d", len(body.Data))
		}
	})
}

// Helper testFunc
func seedWallet(t *testing.T, router http.Handler, address string) WalletResponseEnvelope {
	t.Helper()

	body := fmt.Sprintf(`{"address":"%s","chainId":1,"label":"seed Wallet"}`, address)

	req, err := http.NewRequest(http.MethodPost, "/api/v1/wallets", strings.NewReader(body))
	if err != nil {
		t.Fatalf("failed to create seed request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("failed to seed wallet, expected: %d, got: %d", http.StatusCreated, rec.Code)
	}

	var created WalletResponseEnvelope
	if err = json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("failed to decode seed response body: %v", err)
	}

	return created
}

// authedRouter wraps the router and attaches a bearer token to every request.
// Wallet routes moved behind RequireAuth with migration 0006, so the suite needs
// a real session; minting it through the public register and login endpoints
// keeps the token path (hash at rest, expiry lookup) in the loop rather than
// stubbing the middleware.
type authedRouter struct {
	router http.Handler
	token  string
}

func newAuthedRouter(t *testing.T, walletSvc *wallet.Service, userSvc *user.Service, chainSvc *chain.Service, contractSvc *contract.Service) http.Handler {
	t.Helper()

	plain := NewRouter(walletSvc, userSvc, chainSvc, contractSvc, testLogger(), &stubReadinessChecker{}, unlimitedRateLimiter(), unlimitedRateLimiter())
	creds := `{"email":"wallet-suite@example.com","password":"password123"}`

	registerRec := httptest.NewRecorder()
	plain.ServeHTTP(registerRec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(creds)))
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register wallet suite user: expected %d, got %d body=%s", http.StatusCreated, registerRec.Code, registerRec.Body.String())
	}

	loginRec := httptest.NewRecorder()
	plain.ServeHTTP(loginRec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(creds)))
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login wallet suite user: expected %d, got %d body=%s", http.StatusOK, loginRec.Code, loginRec.Body.String())
	}

	var env LoginResponseEnvelope
	if err := json.NewDecoder(loginRec.Body).Decode(&env); err != nil {
		t.Fatalf("decode login envelope: %v", err)
	}
	if env.Data.Token == "" {
		t.Fatal("login wallet suite user returned an empty token")
	}

	return &authedRouter{router: plain, token: env.Data.Token}
}

func (a *authedRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") == "" {
		r.Header.Set("Authorization", "Bearer "+a.token)
	}
	a.router.ServeHTTP(w, r)
}

// Ownership suite.
//
// Everything above this line runs as a single user: authedRouter mints one
// session and attaches it to every request. The two tests below need two
// accounts, because each ownership invariant is a statement about what user B
// observes when user A owns the row.

// walletOwnershipHarness wires the in-memory router and mints two real sessions
// through the public register and login routes. Passing an empty token to do
// sends no Authorization header, which is how the tokenless case stays reachable.
type walletOwnershipHarness struct {
	router http.Handler
	tokenA string
	tokenB string
}

func newWalletOwnershipHarness(t *testing.T) *walletOwnershipHarness {
	t.Helper()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(wallet.NewInMemoryWalletRepo(), chainSvc)
	userSvc := user.NewService(user.NewInMemoryRepository())
	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := NewRouter(walletSvc, userSvc, chainSvc, contractSvc, testLogger(), &stubReadinessChecker{}, unlimitedRateLimiter(), unlimitedRateLimiter())

	return &walletOwnershipHarness{
		router: router,
		tokenA: mintWalletSession(t, router, "wallet-owner-a@example.com"),
		tokenB: mintWalletSession(t, router, "wallet-owner-b@example.com"),
	}
}

// mintWalletSession registers and logs in one actor, so the tests use the same
// token path (hash at rest, expiry lookup) the middleware enforces in full.
func mintWalletSession(t *testing.T, router http.Handler, email string) string {
	t.Helper()

	creds := fmt.Sprintf(`{"email":%q,"password":"password123"}`, email)

	registerRec := httptest.NewRecorder()
	router.ServeHTTP(registerRec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(creds)))
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register %s: expected %d, got %d body=%s", email, http.StatusCreated, registerRec.Code, registerRec.Body.String())
	}

	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(creds)))
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login %s: expected %d, got %d body=%s", email, http.StatusOK, loginRec.Code, loginRec.Body.String())
	}

	var env LoginResponseEnvelope
	if err := json.NewDecoder(loginRec.Body).Decode(&env); err != nil {
		t.Fatalf("decode login envelope for %s: %v", email, err)
	}
	if env.Data.Token == "" {
		t.Fatalf("login %s returned an empty token", email)
	}

	return env.Data.Token
}

func (h *walletOwnershipHarness) do(t *testing.T, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()

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

func (h *walletOwnershipHarness) create(t *testing.T, token, address string, chainID int64, label string) WalletResponse {
	t.Helper()

	body := fmt.Sprintf(`{"address":%q,"chainId":%d,"label":%q}`, address, chainID, label)
	rec := h.do(t, http.MethodPost, "/api/v1/wallets", body, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed wallet %s: expected %d, got %d body=%s", address, http.StatusCreated, rec.Code, rec.Body.String())
	}

	var env WalletResponseEnvelope
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decode seeded wallet: %v", err)
	}

	return env.Data
}

// A whitespace-only label is a 422 only for a row the caller owns. The service
// resolves the scoped lookup first, so a foreign or missing id is 404 whatever
// the body says. Both directions are pinned: 404 for the two unowned ids and
// 422 for the owned one, so a future reorder that turns 404 into 422 (or 422
// into 404) fails here rather than in review.
func TestUpdateWallet_OwnershipResolvesBeforeLabelValidation(t *testing.T) {
	h := newWalletOwnershipHarness(t)

	owned := h.create(t, h.tokenA, "0x00000000000000000000000000000000000000a1", 1, "owned by A")
	foreign := h.create(t, h.tokenB, "0x00000000000000000000000000000000000000b2", 1, "owned by B")

	const whitespaceLabel = `{"label":"   "}`

	t.Run("foreign id with whitespace label is 404", func(t *testing.T) {
		rec := h.do(t, http.MethodPatch, "/api/v1/wallets/"+strconv.Itoa(int(foreign.ID)), whitespaceLabel, h.tokenA)
		assertErrorCode(t, rec, http.StatusNotFound, CodeResourceNotFound)
	})

	t.Run("missing id with whitespace label is 404", func(t *testing.T) {
		rec := h.do(t, http.MethodPatch, "/api/v1/wallets/999999999", whitespaceLabel, h.tokenA)
		assertErrorCode(t, rec, http.StatusNotFound, CodeResourceNotFound)
	})

	t.Run("owned id with whitespace label is 422", func(t *testing.T) {
		rec := h.do(t, http.MethodPatch, "/api/v1/wallets/"+strconv.Itoa(int(owned.ID)), whitespaceLabel, h.tokenA)
		assertValidationDetails(t, rec, http.StatusUnprocessableEntity, "label")
	})
}

// A foreign id and an id that never existed are the same answer, byte for byte,
// on every wallet route. Any difference lets a caller enumerate other users'
// ids, and an id that exists but belongs to someone else must never surface as
// 403. The all-nil PATCH is included because it is the one body that would
// otherwise short-circuit before the scoped lookup runs.
func TestWalletNotFoundBodiesAreIdentical(t *testing.T) {
	h := newWalletOwnershipHarness(t)

	foreign := h.create(t, h.tokenB, "0x00000000000000000000000000000000000000b3", 1, "owned by B")

	const missingID = "999999999"

	routes := []struct {
		name   string
		method string
		body   string
	}{
		{"GET", http.MethodGet, ""},
		{"PATCH", http.MethodPatch, `{"label":"renamed by A"}`},
		{"DELETE", http.MethodDelete, ""},
	}

	for _, route := range routes {
		t.Run(route.name, func(t *testing.T) {
			foreignRec := h.do(t, route.method, "/api/v1/wallets/"+strconv.Itoa(int(foreign.ID)), route.body, h.tokenA)
			missingRec := h.do(t, route.method, "/api/v1/wallets/"+missingID, route.body, h.tokenA)

			assertErrorCode(t, foreignRec, http.StatusNotFound, CodeResourceNotFound)
			assertErrorCode(t, missingRec, http.StatusNotFound, CodeResourceNotFound)

			if !bytes.Equal(foreignRec.Body.Bytes(), missingRec.Body.Bytes()) {
				t.Errorf("expected byte identical 404 bodies:\nforeign id: %s\nmissing id: %s", foreignRec.Body.String(), missingRec.Body.String())
			}
		})
	}

	t.Run("all nil PATCH on a foreign id is 404", func(t *testing.T) {
		rec := h.do(t, http.MethodPatch, "/api/v1/wallets/"+strconv.Itoa(int(foreign.ID)), `{}`, h.tokenA)
		assertErrorCode(t, rec, http.StatusNotFound, CodeResourceNotFound)
	})

	t.Run("owner still reads the untouched row", func(t *testing.T) {
		rec := h.do(t, http.MethodGet, "/api/v1/wallets/"+strconv.Itoa(int(foreign.ID)), "", h.tokenB)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected %d for the owner, got %d body=%s", http.StatusOK, rec.Code, rec.Body.String())
		}
	})
}
