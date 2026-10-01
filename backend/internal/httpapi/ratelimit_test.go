package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

// stubRateLimiter is a fake tier for router and middleware tests. Negative
// limit means unlimited; otherwise the first limit calls per key set allow and
// every call after that is denied.
type stubRateLimiter struct {
	mu         sync.Mutex
	limit      int
	retryAfter time.Duration
	seen       []string
}

func unlimitedRateLimiter() *stubRateLimiter {
	return &stubRateLimiter{limit: -1}
}

func (s *stubRateLimiter) Allow(key string) (bool, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.seen = append(s.seen, key)
	if s.limit < 0 || len(s.seen) <= s.limit {
		return true, 0
	}
	return false, s.retryAfter
}

func (s *stubRateLimiter) keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]string(nil), s.seen...)
}

func TestRateLimitDeniedWritesEnvelopeAndRetryAfter(t *testing.T) {
	limiter := &stubRateLimiter{limit: 0, retryAfter: 2500 * time.Millisecond}
	handlerRan := false
	handler := rateLimit(limiter)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		handlerRan = true
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/chains", nil)
	req.RemoteAddr = "192.0.2.10:4567"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if handlerRan {
		t.Fatal("the wrapped handler ran for a denied request")
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}
	if got, want := rec.Body.String(), "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"too many requests\"}}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if got, want := rec.Header().Get(retryAfterHeader), "3"; got != want {
		t.Fatalf("Retry-After = %q, want %q", got, want)
	}
	if got, want := rec.Header().Get("Content-Type"), "application/json"; got != want {
		t.Fatalf("Content-Type = %q, want %q", got, want)
	}
	if got, want := limiter.keys(), []string{"ip:192.0.2.10"}; !slices.Equal(got, want) {
		t.Fatalf("limiter keys = %v, want %v", got, want)
	}
}

func TestRateLimitAllowedCallsNextWithoutRetryAfter(t *testing.T) {
	limiter := &stubRateLimiter{limit: 1}
	handlerRan := false
	handler := rateLimit(limiter)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		handlerRan = true
		w.WriteHeader(http.StatusNoContent)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/chains", nil))

	if !handlerRan {
		t.Fatal("the wrapped handler did not run for an allowed request")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if got := rec.Header().Get(retryAfterHeader); got != "" {
		t.Fatalf("Retry-After = %q on an allowed request, want no header", got)
	}
}

func TestRateLimitKeyIsHybrid(t *testing.T) {
	tests := []struct {
		name       string
		remoteAddr string
		userID     int64
		hasUser    bool
		want       string
	}{
		{name: "unauthenticated ipv4 drops the port", remoteAddr: "192.0.2.10:4567", want: "ip:192.0.2.10"},
		{name: "unauthenticated ipv6 drops the port", remoteAddr: "[2001:db8::1]:4567", want: "ip:2001:db8::1"},
		{name: "address without a port is kept", remoteAddr: "192.0.2.10", want: "ip:192.0.2.10"},
		{name: "authenticated keys on the user", remoteAddr: "192.0.2.10:4567", userID: 42, hasUser: true, want: "user:42"},
		{name: "authenticated ignores the address", remoteAddr: "198.51.100.4:9999", userID: 42, hasUser: true, want: "user:42"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets", nil)
			req.RemoteAddr = test.remoteAddr
			if test.hasUser {
				req = req.WithContext(context.WithValue(req.Context(), userCtxKey, user.User{ID: test.userID}))
			}

			if got := rateLimitKey(req); got != test.want {
				t.Fatalf("rateLimitKey() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRetryAfterSecondsRoundsUpToWholeSeconds(t *testing.T) {
	tests := []struct {
		retryAfter time.Duration
		want       string
	}{
		{retryAfter: 0, want: "1"},
		{retryAfter: time.Millisecond, want: "1"},
		{retryAfter: 999 * time.Millisecond, want: "1"},
		{retryAfter: time.Second, want: "1"},
		{retryAfter: 1001 * time.Millisecond, want: "2"},
		{retryAfter: 12 * time.Second, want: "12"},
	}

	for _, test := range tests {
		if got := retryAfterSeconds(test.retryAfter); got != test.want {
			t.Errorf("retryAfterSeconds(%v) = %q, want %q", test.retryAfter, got, test.want)
		}
	}
}

func TestHealthRoutesAreNeverLimited(t *testing.T) {
	global := &stubRateLimiter{limit: 0, retryAfter: time.Second}
	auth := &stubRateLimiter{limit: 0, retryAfter: time.Second}
	router := newRateLimitTestRouter(global, auth)

	for _, path := range []string{"/health", "/health/live", "/health/ready"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200; body=%s", path, rec.Code, rec.Body.String())
		}
	}
	if got := global.keys(); len(got) != 0 {
		t.Fatalf("global limiter saw %v, want no health request", got)
	}
	if got := auth.keys(); len(got) != 0 {
		t.Fatalf("auth limiter saw %v, want no health request", got)
	}

	// The same denying limiters must bite on a limited route, otherwise the
	// assertions above would pass for a limiter that is not wired at all.
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/chains", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("GET /api/v1/chains status = %d, want 429 with a denying global limiter", rec.Code)
	}
}

func TestLoginTighterTierIsAppliedOnlyToTheAuthRoutes(t *testing.T) {
	// The global tier is looser than the auth tier, so the same request count
	// is comfortable on a general route and over the line on login.
	global := &stubRateLimiter{limit: 20}
	auth := &stubRateLimiter{limit: 5, retryAfter: 12 * time.Second}
	router := newRateLimitTestRouter(global, auth)

	loginBody := []byte(`{"email":"nobody@example.com","password":"incorrect-horse"}`)
	for i := 1; i <= 5; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBody))
		router.ServeHTTP(rec, req)

		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("login attempt %d status = 429, want the strict tier to allow the first 5", i)
		}
	}

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBody)))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("sixth login status = %d, want 429", rec.Code)
	}
	if got, want := rec.Header().Get(retryAfterHeader), "12"; got != want {
		t.Fatalf("sixth login Retry-After = %q, want %q", got, want)
	}

	// Six requests to a non-auth route are well inside the global tier and must
	// not be touched by the strict one.
	for i := 1; i <= 6; i++ {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/chains", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("chains request %d status = %d, want 200", i, rec.Code)
		}
	}

	if got := len(auth.keys()); got != 6 {
		t.Fatalf("strict limiter calls = %d, want 6 (login only)", got)
	}
	if got := len(global.keys()); got != 11 {
		t.Fatalf("global limiter calls = %d, want 11 (5 login plus 6 chains)", got)
	}
}

func newRateLimitTestRouter(global, auth RateLimiter) http.Handler {
	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)
	walletSvc := wallet.NewService(wallet.NewInMemoryWalletRepo(), chainSvc)
	userSvc := user.NewService(user.NewInMemoryRepository())
	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	return NewRouter(walletSvc, userSvc, chainSvc, contractSvc, testLogger(), &stubReadinessChecker{}, global, auth)
}
