package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

type stubReadinessChecker struct {
	check func(context.Context) error
	calls int
}

func (s *stubReadinessChecker) Check(ctx context.Context) error {
	s.calls++
	if s.check != nil {
		return s.check(ctx)
	}
	return nil
}

func TestHealthEndpointSuccess(t *testing.T) {
	walletRepo := wallet.NewInMemoryWalletRepo()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(walletRepo, chainSvc)

	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)

	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := NewRouter(walletSvc, userSvc, chainSvc, contractSvc, testEventReader(), testLogger(), &stubReadinessChecker{}, unlimitedRateLimiter(), unlimitedRateLimiter())

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
	walletRepo := wallet.NewInMemoryWalletRepo()

	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)

	walletSvc := wallet.NewService(walletRepo, chainSvc)

	userRepo := user.NewInMemoryRepository()
	userSvc := user.NewService(userRepo)

	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)

	router := NewRouter(walletSvc, userSvc, chainSvc, contractSvc, testEventReader(), testLogger(), &stubReadinessChecker{}, unlimitedRateLimiter(), unlimitedRateLimiter())

	req := httptest.NewRequest(http.MethodPost, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status = %d; got = %d", http.StatusMethodNotAllowed, rec.Code)
	}
	if allow := rec.Header().Get("Allow"); !strings.Contains(allow, "GET") || !strings.Contains(allow, "HEAD") {
		t.Errorf("Allow = %q, want GET and HEAD", allow)
	}
}

func TestHealthLiveAndCompatibilityAliasDoNotCheckDependencies(t *testing.T) {
	checker := &stubReadinessChecker{check: func(context.Context) error {
		return errors.New("liveness must not check PostgreSQL")
	}}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	router := newHealthTestRouter(checker, logger)

	for _, path := range []string{"/health/live", "/health"} {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s status = %d, want 200; body=%s", path, rec.Code, rec.Body.String())
			}
			if got, want := rec.Body.String(), "{\"status\":\"ok\"}\n"; got != want {
				t.Fatalf("GET %s body = %q, want %q", path, got, want)
			}
		})
	}

	headRecorder := httptest.NewRecorder()
	router.ServeHTTP(headRecorder, httptest.NewRequest(http.MethodHead, "/health/live", nil))
	if headRecorder.Code != http.StatusOK {
		t.Fatalf("HEAD /health/live status = %d, want 200", headRecorder.Code)
	}

	postRecorder := httptest.NewRecorder()
	router.ServeHTTP(postRecorder, httptest.NewRequest(http.MethodPost, "/health/live", nil))
	if postRecorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /health/live status = %d, want 405", postRecorder.Code)
	}
	if allow := postRecorder.Header().Get("Allow"); !strings.Contains(allow, "GET") || !strings.Contains(allow, "HEAD") {
		t.Fatalf("POST /health/live Allow = %q, want GET and HEAD", allow)
	}

	if checker.calls != 0 {
		t.Fatalf("liveness called readiness checker %d times, want 0", checker.calls)
	}
	var sawLivenessAccessLog bool
	for _, entry := range decodeHealthLogEntries(t, logs.String()) {
		if entry["msg"] == "request completed" && entry["route"] == "/health/live" {
			sawLivenessAccessLog = true
			break
		}
	}
	if !sawLivenessAccessLog {
		t.Fatalf("liveness access log missing: %s", logs.String())
	}
}

func TestReadinessEndpointSuccessAndAccessLog(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	checker := &stubReadinessChecker{}
	router := newHealthTestRouter(checker, logger)

	req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	req.Header.Set(requestIDHeader, "ready-success-1")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("readiness status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), "{\"status\":\"ok\"}\n"; got != want {
		t.Fatalf("readiness body = %q, want %q", got, want)
	}
	if checker.calls != 1 {
		t.Fatalf("readiness checker calls = %d, want 1", checker.calls)
	}

	entries := decodeHealthLogEntries(t, logs.String())
	if len(entries) != 1 {
		t.Fatalf("log entries = %d, want one access log: %s", len(entries), logs.String())
	}
	if entries[0]["msg"] != "request completed" || entries[0]["route"] != "/health/ready" || entries[0]["request_id"] != "ready-success-1" {
		t.Fatalf("readiness access log = %#v", entries[0])
	}
	if entries[0]["status"] != float64(http.StatusOK) {
		t.Fatalf("readiness access-log status = %v, want 200", entries[0]["status"])
	}
}

func TestReadinessRetriesOnceAndReturnsHealthyOnSecondAttempt(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	checker := &stubReadinessChecker{}
	checker.check = func(context.Context) error {
		if checker.calls == 1 {
			return errors.New("temporary database failure")
		}
		return nil
	}
	router := newHealthTestRouter(checker, logger)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("readiness status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), "{\"status\":\"ok\"}\n"; got != want {
		t.Fatalf("readiness body = %q, want %q", got, want)
	}
	if checker.calls != 2 {
		t.Fatalf("readiness checker calls = %d, want 2", checker.calls)
	}
	for _, entry := range decodeHealthLogEntries(t, logs.String()) {
		if entry["msg"] == "readiness check failed" {
			t.Fatalf("successful retry logged a readiness failure: %s", logs.String())
		}
	}
}

func TestReadinessFailureIsUnavailableAndKeepsCausePrivate(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	cause := errors.New("dial tcp postgres.internal:5432: password=private-value")
	checker := &stubReadinessChecker{check: func(context.Context) error { return cause }}
	router := newHealthTestRouter(checker, logger)

	req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	req.Header.Set(requestIDHeader, "ready-failure-1")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assertNotReadyResponse(t, rec)
	if strings.Contains(rec.Body.String(), cause.Error()) || strings.Contains(rec.Body.String(), "private-value") {
		t.Fatalf("readiness cause leaked to response: %s", rec.Body.String())
	}
	if checker.calls != 2 {
		t.Fatalf("readiness checker calls = %d, want 2", checker.calls)
	}

	entries := decodeHealthLogEntries(t, logs.String())
	var failureLogCount int
	var sawCauseLog, sawAccessLog bool
	for _, entry := range entries {
		switch entry["msg"] {
		case "readiness check failed":
			failureLogCount++
			sawCauseLog = true
			if entry["level"] != "ERROR" || entry["request_id"] != "ready-failure-1" || entry["error"] != cause.Error() {
				t.Errorf("readiness cause log = %#v", entry)
			}
		case "request completed":
			sawAccessLog = true
			if entry["route"] != "/health/ready" || entry["status"] != float64(http.StatusServiceUnavailable) || entry["request_id"] != "ready-failure-1" {
				t.Errorf("readiness access log = %#v", entry)
			}
		}
	}
	if !sawCauseLog || !sawAccessLog {
		t.Fatalf("want both private failure and access logs; got %s", logs.String())
	}
	if failureLogCount != 1 {
		t.Fatalf("readiness failure log count = %d, want 1 after exhausting the retry", failureLogCount)
	}
}

func TestReadyHandlerTimeoutAndRequestCancellation(t *testing.T) {
	t.Run("checker timeout", func(t *testing.T) {
		observed := make(chan error, 1)
		checker := &stubReadinessChecker{check: func(ctx context.Context) error {
			<-ctx.Done()
			observed <- ctx.Err()
			return nil
		}}
		rec := httptest.NewRecorder()
		readyHandler(testLogger(), checker, 20*time.Millisecond).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))

		assertNotReadyResponse(t, rec)
		if got := <-observed; !errors.Is(got, context.DeadlineExceeded) {
			t.Fatalf("checker context error = %v, want deadline exceeded", got)
		}
		if checker.calls != 1 {
			t.Fatalf("readiness checker calls = %d, want 1", checker.calls)
		}
	})

	t.Run("request context canceled", func(t *testing.T) {
		observed := make(chan error, 1)
		checker := &stubReadinessChecker{check: func(ctx context.Context) error {
			observed <- ctx.Err()
			return nil
		}}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		req := httptest.NewRequest(http.MethodGet, "/health/ready", nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		readyHandler(testLogger(), checker, time.Second).ServeHTTP(rec, req)

		assertNotReadyResponse(t, rec)
		if got := <-observed; !errors.Is(got, context.Canceled) {
			t.Fatalf("checker context error = %v, want canceled", got)
		}
		if checker.calls != 1 {
			t.Fatalf("readiness checker calls = %d, want 1", checker.calls)
		}
	})

	t.Run("request context canceled after first failure", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		checker := &stubReadinessChecker{check: func(context.Context) error {
			cancel()
			return errors.New("transient database failure")
		}}
		req := httptest.NewRequest(http.MethodGet, "/health/ready", nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		readyHandler(testLogger(), checker, time.Second).ServeHTTP(rec, req)

		assertNotReadyResponse(t, rec)
		if checker.calls != 1 {
			t.Fatalf("readiness checker calls = %d after cancellation, want 1", checker.calls)
		}
	})
}

func TestReadinessRetryUsesSingleDeadline(t *testing.T) {
	const timeout = 200 * time.Millisecond
	var firstDeadline, secondDeadline time.Time
	checker := &stubReadinessChecker{}
	checker.check = func(ctx context.Context) error {
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("readiness context has no deadline")
		}
		switch checker.calls {
		case 1:
			firstDeadline = deadline
			return errors.New("transient database failure")
		case 2:
			secondDeadline = deadline
			<-ctx.Done()
			return ctx.Err()
		default:
			t.Fatalf("readiness checker called %d times, want at most 2", checker.calls)
			return errors.New("unexpected readiness attempt")
		}
	}

	rec := httptest.NewRecorder()
	readyHandler(testLogger(), checker, timeout).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))

	assertNotReadyResponse(t, rec)
	if checker.calls != 2 {
		t.Fatalf("readiness checker calls = %d, want 2", checker.calls)
	}
	if !firstDeadline.Equal(secondDeadline) {
		t.Fatalf("attempt deadlines differ: first=%s second=%s", firstDeadline, secondDeadline)
	}
}

func TestHasReadinessRetryBudget(t *testing.T) {
	t.Run("enough remains", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if !hasReadinessRetryBudget(ctx, 100*time.Millisecond) {
			t.Fatal("retry was refused with enough budget remaining")
		}
	})

	t.Run("less than the required remainder", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		if hasReadinessRetryBudget(ctx, 100*time.Millisecond) {
			t.Fatal("retry was allowed with too little budget remaining")
		}
	})

	t.Run("deadline expired", func(t *testing.T) {
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		defer cancel()
		if hasReadinessRetryBudget(ctx, 0) {
			t.Fatal("retry was allowed after the deadline")
		}
	})

	t.Run("request canceled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if hasReadinessRetryBudget(ctx, 0) {
			t.Fatal("retry was allowed after request cancellation")
		}
	})
}

func newHealthTestRouter(checker ReadinessChecker, logger *slog.Logger) http.Handler {
	walletRepo := wallet.NewInMemoryWalletRepo()
	chainRepo := chain.NewInMemoryRepository()
	chainRepo.Seed(chain.Chain{ChainID: 1, Name: "Ethereum", Symbol: "ETH", Enabled: true})
	chainSvc := chain.NewService(chainRepo)
	walletSvc := wallet.NewService(walletRepo, chainSvc)
	userSvc := user.NewService(user.NewInMemoryRepository())
	contractSvc := contract.NewService(contract.NewInMemoryRepository(), chainSvc)
	if logger == nil {
		logger = testLogger()
	}
	return NewRouter(walletSvc, userSvc, chainSvc, contractSvc, testEventReader(), logger, checker, unlimitedRateLimiter(), unlimitedRateLimiter())
}

func assertNotReadyResponse(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), "{\"error\":{\"code\":\"SERVICE_UNAVAILABLE\",\"message\":\"not ready\"}}\n"; got != want {
		t.Fatalf("readiness response = %q, want %q", got, want)
	}
}

func decodeHealthLogEntries(t *testing.T, logOutput string) []map[string]any {
	t.Helper()
	var entries []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logOutput), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("decode health log %q: %v", line, err)
		}
		entries = append(entries, entry)
	}
	return entries
}
