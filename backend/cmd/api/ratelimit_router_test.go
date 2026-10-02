package main

// Integration coverage for the documented tiers: the limiter implementation in
// ratelimit.go wired into the real router, the real middleware, and the real
// handlers, with only the clock injected.

import (
	"context"
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
	t.Run("the global tier counts every route once", func(t *testing.T) {
		router := newRateLimitedTestRouter(newFakeClock())
		address := "192.0.2.20:41000"
		const loginBody = `{"email":"nobody@example.com","password":"incorrect-horse"}`

		// Spend nine of the ten starting tokens on a public route.
		for i := 1; i <= globalLimitBurst-1; i++ {
			if rec := get(t, router, "/api/v1/chains", address, ""); rec.Code != http.StatusOK {
				t.Fatalf("chains request %d status = %d, want 200", i, rec.Code)
			}
		}

		// The tenth request is a login. It must be allowed, which proves the
		// chain-wide tier consumes exactly one token for it and not two.
		if rec := postJSON(t, router, "/api/v1/auth/login", address, loginBody); rec.Code != http.StatusUnauthorized {
			t.Fatalf("login status = %d with one global token left, want 401; body=%s", rec.Code, rec.Body.String())
		}

		rec := get(t, router, "/api/v1/chains", address, "")
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("chains status = %d after the burst, want 429", rec.Code)
		}
		if got, want := rec.Header().Get("Retry-After"), "1"; got != want {
			t.Fatalf("Retry-After = %q, want %q for 60 requests per minute", got, want)
		}
		if got, want := rec.Body.String(), "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"too many requests\"}}\n"; got != want {
			t.Fatalf("429 body = %q, want %q", got, want)
		}
	})

	t.Run("the auth tier bites at its own burst and refills in twelve seconds", func(t *testing.T) {
		clock := newFakeClock()
		router := newRateLimitedTestRouter(clock)
		const loginBody = `{"email":"nobody@example.com","password":"incorrect-horse"}`
		address := "192.0.2.21:41001"

		for i := 1; i <= authLimitBurst; i++ {
			if rec := postJSON(t, router, "/api/v1/auth/login", address, loginBody); rec.Code != http.StatusUnauthorized {
				t.Fatalf("login %d status = %d, want 401; body=%s", i, rec.Code, rec.Body.String())
			}
		}

		rec := postJSON(t, router, "/api/v1/auth/login", address, loginBody)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("login %d status = %d, want 429 at the auth burst of %d", authLimitBurst+1, rec.Code, authLimitBurst)
		}
		if got, want := rec.Header().Get("Retry-After"), "12"; got != want {
			t.Fatalf("login Retry-After = %q, want %q for 5 requests per minute", got, want)
		}

		clock.advance(15 * time.Second)
		if rec := postJSON(t, router, "/api/v1/auth/login", address, loginBody); rec.Code != http.StatusUnauthorized {
			t.Fatalf("login status = %d after 15s of refill, want the single refilled token allowed", rec.Code)
		}
		if rec := postJSON(t, router, "/api/v1/auth/login", address, loginBody); rec.Code != http.StatusTooManyRequests {
			t.Fatalf("login status = %d, want 429 once the refilled token is spent", rec.Code)
		}
	})

	t.Run("a bad bearer token is rate limited before authentication runs", func(t *testing.T) {
		router := newRateLimitedTestRouter(newFakeClock())
		address := "192.0.2.22:41002"

		// Every one of these reaches requireAuth and is rejected there. The
		// limiter sits above authentication, so the burst still runs out.
		for i := 1; i <= globalLimitBurst; i++ {
			rec := get(t, router, "/api/v1/wallets", address, "not-a-real-token")
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("request %d with a bad token status = %d, want 401; body=%s", i, rec.Code, rec.Body.String())
			}
		}

		rec := get(t, router, "/api/v1/wallets", address, "not-a-real-token")
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("garbage-token request %d status = %d, want 429 before the session lookup", globalLimitBurst+1, rec.Code)
		}

		// A different client address still has its own budget.
		if rec := get(t, router, "/api/v1/wallets", "192.0.2.23:41003", "not-a-real-token"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("second address status = %d, want 401 on its own budget", rec.Code)
		}
	})

	t.Run("health paths are exempt with an empty bucket", func(t *testing.T) {
		router := newRateLimitedTestRouter(newFakeClock())
		address := "192.0.2.24:41004"

		for i := 1; i <= globalLimitBurst; i++ {
			get(t, router, "/api/v1/chains", address, "")
		}
		if rec := get(t, router, "/api/v1/chains", address, ""); rec.Code != http.StatusTooManyRequests {
			t.Fatalf("chains status = %d, want the bucket spent before the health checks", rec.Code)
		}

		for _, path := range []string{"/health", "/health/live", "/health/ready"} {
			if rec := get(t, router, path, address, ""); rec.Code != http.StatusOK {
				t.Fatalf("GET %s status = %d with an empty bucket, want 200; body=%s", path, rec.Code, rec.Body.String())
			}
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
