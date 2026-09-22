package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func TestListChainsEndpoint(t *testing.T) {
	t.Run("returns only enabled chains in ascending order", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()
		chainRepo := chain.NewInMemoryRepository()
		chainRepo.Seed(
			chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true},
			chain.Chain{ChainID: 137, Name: "Polygon", Symbol: "POL", Enabled: true},
			chain.Chain{ChainID: 999, Name: "Disabled", Symbol: "X", Enabled: false},
		)
		chainSvc := chain.NewService(chainRepo)
		walletSvc := wallet.NewService(walletRepo, chainSvc)
		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)
		router := NewRouter(walletSvc, userSvc, chainSvc)

		req := httptest.NewRequest(http.MethodGet, "/api/v1/chains", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}

		respBytes := rec.Body.Bytes()

		// 1. DTO decode
		var body ChainResponseEnvelope
		if err := json.Unmarshal(respBytes, &body); err != nil {
			t.Fatalf("decode DTO envelope: %v", err)
		}

		if len(body.Data) != 2 {
			t.Fatalf("expected 2 enabled chains, got %d", len(body.Data))
		}

		for _, c := range body.Data {
			if c.ChainID == 999 {
				t.Fatal("disabled chain 999 must not appear in response")
			}
		}

		if body.Data[0].ChainID >= body.Data[1].ChainID {
			t.Fatalf("expected ascending order, got %d then %d",
				body.Data[0].ChainID, body.Data[1].ChainID)
		}

		// 2. Regression guard: key-set assertion (prevents domain field leak)
		var rawBody struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal(respBytes, &rawBody); err != nil {
			t.Fatalf("decode raw map for key-set check: %v", err)
		}

		allowedKeys := map[string]bool{
			"chainId":   true,
			"name":      true,
			"symbol":    true,
			"isTestnet": true,
		}

		for _, item := range rawBody.Data {
			if len(item) != 4 {
				t.Fatalf("expected exactly 4 keys per chain object, got %d: %v", len(item), item)
			}
			for k := range item {
				if !allowedKeys[k] {
					t.Fatalf("unexpected leaked key %q in response: %v", k, item)
				}
			}
		}
	})

	t.Run("empty repo returns empty array not null", func(t *testing.T) {
		walletRepo := wallet.NewInMemoryWalletRepo()
		chainRepo := chain.NewInMemoryRepository()
		chainSvc := chain.NewService(chainRepo)
		walletSvc := wallet.NewService(walletRepo, chainSvc)
		userRepo := user.NewInMemoryRepository()
		userSvc := user.NewService(userRepo)
		router := NewRouter(walletSvc, userSvc, chainSvc)

		req := httptest.NewRequest(http.MethodGet, "/api/v1/chains", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}

		var raw map[string]json.RawMessage
		if err := json.NewDecoder(rec.Body).Decode(&raw); err != nil {
			t.Fatalf("decode: %v", err)
		}

		if string(raw["data"]) != "[]" {
			t.Fatalf("expected data:[], got data:%s", string(raw["data"]))
		}
	})
}
