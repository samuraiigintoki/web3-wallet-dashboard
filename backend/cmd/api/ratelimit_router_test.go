package main

// Integration coverage for the documented tiers: the limiter implementation in
// ratelimit.go wired into the real router, the real middleware, and the real
// handlers, with only the clock injected.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

type stubReadinessCheck struct{ err error }

func (s stubReadinessCheck) Check(context.Context) error { return s.err }

func TestRateLimitTiersThroughTheRouter(t *testing.T) {
	t.Run("the auth tier bites before the global tier does", func(t *testing.T) {
		router := newRateLimitedTestRouter(newFakeClock())
		const loginBody = `{"email":"nobody@example.com","password":"incorrect-horse"}`
		const authAddress = "192.0.2.7:40000"
		const generalAddress = "192.0.2.70:40001"

		for i := 1; i <= authLimitBurst; i++ {
			if rec := postJSON(t, router, "/api/v1/auth/login", authAddress, loginBody); rec.Code != http.StatusUnauthorized {
				t.Fatalf("login %d status = %d, want 401; body=%s", i, rec.Code, rec.Body.String())
			}
		}
		rec := postJSON(t, router, "/api/v1/auth/login", authAddress, loginBody)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("login %d status = %d, want 429 at the auth burst of %d", authLimitBurst+1, rec.Code, authLimitBurst)
		}
		if got, want := rec.Header().Get("Retry-After"), "12"; got != want {
			t.Fatalf("login Retry-After = %q, want %q for 5 requests per minute", got, want)
		}
		if got, want := rec.Body.String(), "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"too many requests\"}}\n"; got != want {
			t.Fatalf("429 body = %q, want %q", got, want)
		}

		// The same request count on a non-auth route is nowhere near the global
		// tier, and the global burst is ten starting tokens.
		for i := 1; i <= authLimitBurst+1; i++ {
			if rec := get(t, router, "/api/v1/chains", generalAddress, ""); rec.Code != http.StatusOK {
				t.Fatalf("chains request %d status = %d, want 200; body=%s", i, rec.Code, rec.Body.String())
			}
		}
		for i := authLimitBurst + 2; i <= globalLimitBurst; i++ {
			if rec := get(t, router, "/api/v1/chains", generalAddress, ""); rec.Code != http.StatusOK {
				t.Fatalf("chains request %d status = %d, want 200 inside the global burst of %d", i, rec.Code, globalLimitBurst)
			}
		}
		rec = get(t, router, "/api/v1/chains", generalAddress, "")
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("chains request %d status = %d, want 429 at the global burst of %d", globalLimitBurst+1, rec.Code, globalLimitBurst)
		}
		if got, want := rec.Header().Get("Retry-After"), "1"; got != want {
			t.Fatalf("chains Retry-After = %q, want %q for 60 requests per minute", got, want)
		}
	})

	t.Run("the auth tier refills one request every twelve seconds", func(t *testing.T) {
		clock := newFakeClock()
		router := newRateLimitedTestRouter(clock)
		const loginBody = `{"email":"nobody@example.com","password":"incorrect-horse"}`
		address := "192.0.2.8:40001"

		for i := 1; i <= authLimitBurst; i++ {
			postJSON(t, router, "/api/v1/auth/login", address, loginBody)
		}
		if rec := postJSON(t, router, "/api/v1/auth/login", address, loginBody); rec.Code != http.StatusTooManyRequests {
			t.Fatalf("login status = %d, want 429 before any refill", rec.Code)
		}

		clock.advance(15 * time.Second)
		if rec := postJSON(t, router, "/api/v1/auth/login", address, loginBody); rec.Code != http.StatusUnauthorized {
			t.Fatalf("login status = %d after 15s of refill, want one allowed request", rec.Code)
		}
		if rec := postJSON(t, router, "/api/v1/auth/login", address, loginBody); rec.Code != http.StatusTooManyRequests {
			t.Fatalf("login status = %d, want 429 after the single refilled token is spent", rec.Code)
		}
	})

	t.Run("authenticated routes bucket per user, not per address", func(t *testing.T) {
		router := newRateLimitedTestRouter(newFakeClock())
		const sharedAddress = "203.0.113.9:40100"

		firstToken := registerAndLogin(t, router, "192.0.2.11:41000", "first@example.com")
		secondToken := registerAndLogin(t, router, "192.0.2.12:41001", "second@example.com")

		// Spend the whole global bucket for the shared address on an anonymous
		// route, so a per-address key would deny everything below.
		for i := 1; i <= globalLimitBurst; i++ {
			if rec := get(t, router, "/api/v1/chains", sharedAddress, ""); rec.Code != http.StatusOK {
				t.Fatalf("chains request %d status = %d, want 200", i, rec.Code)
			}
		}
		if rec := get(t, router, "/api/v1/chains", sharedAddress, ""); rec.Code != http.StatusTooManyRequests {
			t.Fatalf("chains status = %d, want the shared address bucket spent before the user checks", rec.Code)
		}

		if rec := get(t, router, "/api/v1/wallets", sharedAddress, firstToken); rec.Code != http.StatusOK {
			t.Fatalf("first user status = %d with the address bucket spent, want 200; body=%s", rec.Code, rec.Body.String())
		}
		if rec := get(t, router, "/api/v1/wallets", sharedAddress, secondToken); rec.Code != http.StatusOK {
			t.Fatalf("second user status = %d on the same address, want 200; body=%s", rec.Code, rec.Body.String())
		}

		for i := 2; i <= globalLimitBurst; i++ {
			if rec := get(t, router, "/api/v1/wallets", sharedAddress, firstToken); rec.Code != http.StatusOK {
				t.Fatalf("first user request %d status = %d, want 200 inside the burst", i, rec.Code)
			}
		}
		if rec := get(t, router, "/api/v1/wallets", sharedAddress, firstToken); rec.Code != http.StatusTooManyRequests {
			t.Fatalf("first user status = %d after the burst, want 429", rec.Code)
		}
		if rec := get(t, router, "/api/v1/wallets", sharedAddress, secondToken); rec.Code != http.StatusOK {
			t.Fatalf("second user status = %d after the first user was limited, want 200", rec.Code)
		}
	})
}

func newRateLimitedTestRouter(clock *fakeClock) http.Handler {
	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)
	walletSvc := wallet.NewService(wallet.NewInMemoryWalletRepo(), chainSvc)
	userSvc := user.NewService(user.NewInMemoryRepository())
	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	global := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	global.now = clock.Now
	auth := newTokenBucketLimiter(authLimitPerMinute, authLimitBurst)
	auth.now = clock.Now

	return httpapi.NewRouter(walletSvc, userSvc, chainSvc, contractSvc, discardLogger(), stubReadinessCheck{}, global, auth)
}

func registerAndLogin(t *testing.T, router http.Handler, address, email string) string {
	t.Helper()
	const password = "correct-horse-battery"

	rec := postJSON(t, router, "/api/v1/auth/register", address, `{"email":"`+email+`","password":"`+password+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register %s status = %d, want 201; body=%s", email, rec.Code, rec.Body.String())
	}

	rec = postJSON(t, router, "/api/v1/auth/login", address, `{"email":"`+email+`","password":"`+password+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("login %s status = %d, want 200; body=%s", email, rec.Code, rec.Body.String())
	}

	var body struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode login response for %s: %v", email, err)
	}
	if body.Data.Token == "" {
		t.Fatalf("login response for %s carries no token", email)
	}
	return body.Data.Token
}

func get(t *testing.T, router http.Handler, path, address, token string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = address
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func postJSON(t *testing.T, router http.Handler, path, address, body string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.RemoteAddr = address
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}
