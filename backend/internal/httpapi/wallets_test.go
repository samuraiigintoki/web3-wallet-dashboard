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
			name: "method not allowed", method: http.MethodGet, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
    			"chainId": 1,
    			"label": "Primary Sepolia signer"
				}`,
			expectedStatus: http.StatusMethodNotAllowed},
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
