package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func TestHealthEndpointSuccess(t *testing.T) {
	repo := wallet.NewInMemoryWalletRepo()
	walletSvc := wallet.NewService(repo)
	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)

	router := NewRouter(walletSvc, userSvc)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status = %d; got = %d", http.StatusOK, rec.Code)
	}

	expectedType := "application/json"
	if ct := rec.Header().Get("Content-Type"); ct != expectedType {
		t.Errorf("Expected Content-type = %q; got = %q", expectedType, ct)
	}

	var res healthResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("failed to decode response body: %v", err)
	}

	wantStatus := "ok"
	if res.Status != wantStatus {
		t.Errorf("expected status: %q , got: %q", wantStatus, res.Status)
	}
}

func TestHealthEndpointMethodNotAllowed(t *testing.T) {
	repo := wallet.NewInMemoryWalletRepo()
	walletSvc := wallet.NewService(repo)
	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)
	router := NewRouter(walletSvc, userSvc)

	req := httptest.NewRequest(http.MethodPost, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status = %d; got = %d", http.StatusMethodNotAllowed, rec.Code)
	}
}
