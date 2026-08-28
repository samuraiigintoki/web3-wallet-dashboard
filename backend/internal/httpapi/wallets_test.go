package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateAddress(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{name: "valid address", input: "0x0000000000000000000000000000000000000001", wantErr: false},
		{name: "empty address", input: "", wantErr: true},
		{name: "missing 0x", input: "1111000000000000000000000000000000000001",
			wantErr: true},
		{name: "invalid address length", input: "0x12345678", wantErr: true},
		{name: "address contains whitespace", input: "0x  sdf sdf sdfsdf 23435 sd46", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateAddress(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("valdateAddress(%q) error = %v, wantErr = %v", tt.input, err, tt.wantErr)
			}
		})
	}
}

func TestValidateLabel(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{name: "valid label", input: "Main Wallet", wantErr: false},
		{name: "empty label", input: "", wantErr: true},
		{name: "50 characters", input: strings.Repeat("a", 50), wantErr: false},
		{name: "Invalid 51 characters", input: "MyPersonalPrimarySecureHotWalletAccountIdentifierExceeds51Characters", wantErr: true},
		{name: "label exceeding 50 runes with Devanagari", input: "तेज़भूड़ीलोमड़ीआलसीकुत्तेकेऊपरसेकूदतीहैताकिटेस्टपासहavbd", wantErr: true},
		{name: "valid Cyrillic label", input: "Кошелек", wantErr: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateLabel(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateLabel(%q) error = %v, want = %v", tt.input, err, tt.wantErr)
			}
		})
	}
}

func TestCreateWalletEndpoint(t *testing.T) {
	router := NewRouter()

	tests := []struct {
		name           string
		method         string
		path           string
		body           string
		expectedStatus int
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
			expectedStatus: http.StatusBadRequest},
		{
			name: "empty body", method: http.MethodPost, path: "/api/v1/wallets",
			body:           "",
			expectedStatus: http.StatusBadRequest},
		{
			name: "unknown field", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
    			"chainId": 1,
    			"label": "Primary Sepolia signer",
				"nickname":"xpose gtaVI"
				}`,
			expectedStatus: http.StatusBadRequest},
		{
			name: "chainId as string", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
    			"chainId": "1",
    			"label": "Primary Sepolia signer"
				}`,
			expectedStatus: http.StatusBadRequest},
		{
			name: "address wrong length", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x12345678",
    			"chainId": 1,
    			"label": "Primary Sepolia signer"
				}`,
			expectedStatus: http.StatusBadRequest},
		{
			name: "address missing 0x prefix", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "ab0000000000000000000000000000000000000001",
    			"chainId": 1,
    			"label": "Primary Sepolia signer"
				}`,
			expectedStatus: http.StatusBadRequest},
		{
			name: "empty label", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
    			"chainId": 1,
    			"label": ""
				}`,
			expectedStatus: http.StatusBadRequest},
		{
			name: "40 unicode character string", method: http.MethodPost, path: "/api/v1/wallets",
			body: `{
    			"address": "0x0000000000000000000000000000000000000001",
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
			expectedStatus: http.StatusBadRequest},
		{
			name: "oversized body", method: http.MethodPost, path: "/api/v1/wallets",
			body:           strings.Repeat("a", 1<<20+100),
			expectedStatus: http.StatusBadRequest},
		{name: "method not allowed", method: http.MethodGet, path: "/api/v1/wallets",
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
		})
	}
}
