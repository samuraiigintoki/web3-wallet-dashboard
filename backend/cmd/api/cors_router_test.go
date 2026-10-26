package main

// The CORS policy against the real router, so the placement is proved rather
// than assumed: a preflight must never reach authentication, a handler or the
// rate limiter, and an allowed origin must see the header on the response the
// handler actually produced.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
)

const routerTestOrigin = "https://web3-wallet-dashboard.onrender.com"

func corsRouter(t *testing.T, raw string) http.Handler {
	t.Helper()

	policy, err := httpapi.ParseCORSOrigins(raw)
	if err != nil {
		t.Fatalf("ParseCORSOrigins(%q) error = %v", raw, err)
	}

	return httpapi.WithCORS(newRateLimitedTestRouter(newFakeClock()), policy)
}

func TestPreflightThroughTheRouter(t *testing.T) {
	t.Run("an allowed preflight is answered without consulting a handler", func(t *testing.T) {
		router := corsRouter(t, routerTestOrigin)

		req := httptest.NewRequest(http.MethodOptions, "/api/v1/wallets", nil)
		req.RemoteAddr = "192.0.2.30:42000"
		req.Header.Set("Origin", routerTestOrigin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")

		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204; body=%s", rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != routerTestOrigin {
			t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, routerTestOrigin)
		}
		// No error envelope, no request id: nothing downstream ran.
		if body := rec.Body.String(); body != "" {
			t.Fatalf("preflight body = %q, want empty", body)
		}
		if got := rec.Header().Get("X-Request-ID"); got != "" {
			t.Fatalf("preflight carried X-Request-ID %q, so it went through the router", got)
		}
	})

	t.Run("a preflight does not spend the caller's rate-limit budget", func(t *testing.T) {
		router := corsRouter(t, routerTestOrigin)
		address := "192.0.2.31:42001"

		// More preflights than the global burst allows. If any of them were
		// counted, the first real request afterwards would be refused.
		for i := 0; i <= globalLimitBurst+5; i++ {
			req := httptest.NewRequest(http.MethodOptions, "/api/v1/chains", nil)
			req.RemoteAddr = address
			req.Header.Set("Origin", routerTestOrigin)
			req.Header.Set("Access-Control-Request-Method", "GET")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusNoContent {
				t.Fatalf("preflight %d status = %d, want 204", i, rec.Code)
			}
		}

		if rec := get(t, router, "/api/v1/chains", address, ""); rec.Code != http.StatusOK {
			t.Fatalf("chains status = %d after %d preflights, want 200", rec.Code, globalLimitBurst+6)
		}
	})

	t.Run("a refused preflight never reaches a handler", func(t *testing.T) {
		router := corsRouter(t, routerTestOrigin)

		req := httptest.NewRequest(http.MethodOptions, "/api/v1/chains", nil)
		req.RemoteAddr = "192.0.2.32:42002"
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Access-Control-Request-Method", "GET")

		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("Access-Control-Allow-Origin = %q, want it unset", got)
		}
	})
}

func TestCORSThroughTheRouter(t *testing.T) {
	t.Run("an allowed origin is marked on a public route", func(t *testing.T) {
		router := corsRouter(t, routerTestOrigin)

		req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
		req.RemoteAddr = "192.0.2.33:42003"
		req.Header.Set("Origin", routerTestOrigin)

		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != routerTestOrigin {
			t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, routerTestOrigin)
		}
	})

	t.Run("an unconfigured deployment answers no cross-origin read", func(t *testing.T) {
		router := corsRouter(t, "")

		req := httptest.NewRequest(http.MethodGet, "/health/live", nil)
		req.RemoteAddr = "192.0.2.34:42004"
		req.Header.Set("Origin", routerTestOrigin)

		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("Access-Control-Allow-Origin = %q, want it unset", got)
		}
	})

	t.Run("health probes without an origin are untouched", func(t *testing.T) {
		router := corsRouter(t, routerTestOrigin)

		rec := get(t, router, "/health/live", "192.0.2.35:42005", "")

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		for _, header := range []string{"Access-Control-Allow-Origin", "Vary"} {
			if got := rec.Header().Get(header); got != "" {
				t.Fatalf("%s = %q on a probe with no origin, want it unset", header, got)
			}
		}
	})
}
