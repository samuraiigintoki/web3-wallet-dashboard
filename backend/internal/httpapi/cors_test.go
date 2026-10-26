package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// One frontend origin, one API, and the questions a browser asks between them.
//
// The middleware is exercised on its own here: what it decides does not depend
// on any handler, and a test that went through a real route would be testing the
// route as much as the policy.

const testFrontendOrigin = "https://web3-wallet-dashboard.onrender.com"

func mustPolicy(t *testing.T, raw string) CORSPolicy {
	t.Helper()

	policy, err := ParseCORSOrigins(raw)
	if err != nil {
		t.Fatalf("ParseCORSOrigins(%q) error = %v", raw, err)
	}

	return policy
}

// recorder is a handler that reports it was reached, so a test can tell an
// answered preflight from a passed-through request.
type recorder struct{ reached bool }

func (h *recorder) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	h.reached = true
	w.WriteHeader(http.StatusOK)
}

func corsRequest(method string, headers map[string]string) *http.Request {
	req := httptest.NewRequest(method, "/api/v1/chains", nil)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	return req
}

func TestCORSPreflight(t *testing.T) {
	t.Run("an allowed origin is answered without reaching a handler", func(t *testing.T) {
		policy := mustPolicy(t, testFrontendOrigin)
		next := &recorder{}
		handler := WithCORS(next, policy)

		req := corsRequest(http.MethodOptions, map[string]string{
			"Origin":                         testFrontendOrigin,
			"Access-Control-Request-Method":  "POST",
			"Access-Control-Request-Headers": "authorization,content-type",
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
		}
		if next.reached {
			t.Fatal("the handler was reached by a preflight")
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != testFrontendOrigin {
			t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, testFrontendOrigin)
		}
		if got, want := rec.Header().Get("Access-Control-Allow-Methods"), corsAllowedMethods; got != want {
			t.Fatalf("Access-Control-Allow-Methods = %q, want %q", got, want)
		}
		if got, want := rec.Header().Get("Access-Control-Allow-Headers"), corsAllowedHeaders; got != want {
			t.Fatalf("Access-Control-Allow-Headers = %q, want %q", got, want)
		}
		if got, want := rec.Header().Get("Access-Control-Max-Age"), corsMaxAge; got != want {
			t.Fatalf("Access-Control-Max-Age = %q, want %q", got, want)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
			t.Fatalf("Access-Control-Allow-Credentials = %q, want it unset", got)
		}
		if got := rec.Header().Values("Vary"); len(got) != 1 || got[0] != "Origin" {
			t.Fatalf("Vary = %v, want [Origin]", got)
		}
	})

	t.Run("an origin that is not allowed is refused by name and reaches nothing", func(t *testing.T) {
		policy := mustPolicy(t, testFrontendOrigin)
		next := &recorder{}
		handler := WithCORS(next, policy)

		req := corsRequest(http.MethodOptions, map[string]string{
			"Origin":                        "https://evil.example",
			"Access-Control-Request-Method": "POST",
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
		}
		if next.reached {
			t.Fatal("the handler was reached by a refused preflight")
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("Access-Control-Allow-Origin = %q, want it unset", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "" {
			t.Fatalf("Access-Control-Allow-Methods = %q, want it unset", got)
		}
	})

	t.Run("an empty policy refuses every preflight", func(t *testing.T) {
		next := &recorder{}
		handler := WithCORS(next, CORSPolicy{})

		req := corsRequest(http.MethodOptions, map[string]string{
			"Origin":                        testFrontendOrigin,
			"Access-Control-Request-Method": "GET",
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
		}
		if next.reached {
			t.Fatal("the handler was reached with no origin configured")
		}
	})
}

func TestCORSActualRequest(t *testing.T) {
	t.Run("an allowed origin is marked on the response", func(t *testing.T) {
		policy := mustPolicy(t, testFrontendOrigin)
		handler := WithCORS(&recorder{}, policy)

		req := corsRequest(http.MethodGet, map[string]string{"Origin": testFrontendOrigin})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != testFrontendOrigin {
			t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, testFrontendOrigin)
		}
		if got, want := rec.Header().Get("Access-Control-Expose-Headers"), corsExposedHeaders; got != want {
			t.Fatalf("Access-Control-Expose-Headers = %q, want %q", got, want)
		}
	})

	t.Run("an origin that is not allowed is served, without the header that would release it", func(t *testing.T) {
		policy := mustPolicy(t, testFrontendOrigin)
		next := &recorder{}
		handler := WithCORS(next, policy)

		req := corsRequest(http.MethodGet, map[string]string{"Origin": "https://evil.example"})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !next.reached {
			t.Fatal("the request did not reach the handler")
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("Access-Control-Allow-Origin = %q, want it unset", got)
		}
		if got := rec.Header().Values("Vary"); len(got) != 1 || got[0] != "Origin" {
			t.Fatalf("Vary = %v, want [Origin]", got)
		}
	})

	t.Run("a request with no origin is untouched", func(t *testing.T) {
		policy := mustPolicy(t, testFrontendOrigin)
		handler := WithCORS(&recorder{}, policy)

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/live", nil))

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		for _, header := range []string{
			"Access-Control-Allow-Origin",
			"Access-Control-Expose-Headers",
			"Vary",
		} {
			if got := rec.Header().Get(header); got != "" {
				t.Fatalf("%s = %q on a request with no origin, want it unset", header, got)
			}
		}
	})

	t.Run("an OPTIONS request without a preflight header is passed through", func(t *testing.T) {
		policy := mustPolicy(t, testFrontendOrigin)
		next := &recorder{}
		handler := WithCORS(next, policy)

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, corsRequest(http.MethodOptions, map[string]string{
			"Origin": testFrontendOrigin,
		}))

		if !next.reached {
			t.Fatal("an OPTIONS request that is not a preflight was answered as one")
		}
	})
}

func TestParseCORSOrigins(t *testing.T) {
	t.Run("an empty value allows nothing", func(t *testing.T) {
		policy := mustPolicy(t, "")

		if policy.Len() != 0 {
			t.Fatalf("Len = %d, want 0", policy.Len())
		}
		if policy.Allows(testFrontendOrigin) {
			t.Fatal("an empty policy allowed an origin")
		}
	})

	t.Run("a list is split, trimmed and de-duplicated", func(t *testing.T) {
		policy := mustPolicy(t, " https://a.example , https://b.example ,https://a.example , ")

		if policy.Len() != 2 {
			t.Fatalf("Len = %d, want 2", policy.Len())
		}
		if !policy.Allows("https://a.example") || !policy.Allows("https://b.example") {
			t.Fatal("a configured origin was not allowed")
		}
	})

	t.Run("loopback over http is allowed for local development", func(t *testing.T) {
		policy := mustPolicy(t, "http://localhost:5173,http://127.0.0.1:4173")

		if !policy.Allows("http://localhost:5173") || !policy.Allows("http://127.0.0.1:4173") {
			t.Fatal("a loopback origin was refused")
		}
	})

	t.Run("a bad entry is a startup error, not a silent omission", func(t *testing.T) {
		for _, raw := range []string{
			"*",
			"https://*.example.com",
			"https://app.example.com/",
			"https://app.example.com/path",
			"https://app.example.com?x=1",
			"https://user:pass@app.example.com",
			"https://",
			"http://app.example.com",
			"ftp://app.example.com",
			"app.example.com",
			"HTTPS://APP.EXAMPLE.COM",
			"https://app.example.com:443",
		} {
			if _, err := ParseCORSOrigins(raw); err == nil {
				t.Fatalf("ParseCORSOrigins(%q) accepted a value it should refuse", raw)
			}
		}
	})

	t.Run("a host with a port that is not the default is allowed", func(t *testing.T) {
		policy := mustPolicy(t, "https://app.example.com:8443")

		if !policy.Allows("https://app.example.com:8443") {
			t.Fatal("a non-default port was refused")
		}
		if policy.Allows("https://app.example.com") {
			t.Fatal("an origin without the port matched one with it")
		}
	})

	t.Run("more than the cap is refused", func(t *testing.T) {
		origins := make([]string, 0, maxCORSOrigins+1)
		for i := 0; i <= maxCORSOrigins; i++ {
			origins = append(origins, "https://o"+strings.Repeat("a", i+1)+".example")
		}

		if _, err := ParseCORSOrigins(strings.Join(origins, ",")); err == nil {
			t.Fatalf("ParseCORSOrigins accepted %d origins", len(origins))
		}

		if _, err := ParseCORSOrigins(strings.Join(origins[:maxCORSOrigins], ",")); err != nil {
			t.Fatalf("ParseCORSOrigins refused exactly the cap: %v", err)
		}
	})

	t.Run("matching is exact, so a lookalike host is not allowed", func(t *testing.T) {
		policy := mustPolicy(t, testFrontendOrigin)

		for _, origin := range []string{
			"https://web3-wallet-dashboard.onrender.com.evil.example",
			"https://web3-wallet-dashboard.onrender.co",
			"http://web3-wallet-dashboard.onrender.com",
			"https://web3-wallet-dashboard.onrender.com:443",
			"https://WEB3-WALLET-DASHBOARD.onrender.com",
			"https://web3-wallet-dashboard.onrender.com/",
		} {
			if policy.Allows(origin) {
				t.Fatalf("Allows(%q) = true, want false", origin)
			}
		}
	})
}
