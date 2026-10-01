package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
)

func TestRequestIDMiddleware(t *testing.T) {
	tests := []struct {
		name      string
		requestID string
		wantSame  bool
	}{
		{name: "accept valid client value", requestID: "client-123._ok", wantSame: true},
		{name: "generate when absent"},
		{name: "replace invalid value", requestID: "bad/id"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := requestIDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fields, ok := requestLogFieldsFromContext(r.Context())
				if !ok {
					t.Fatal("request log fields are missing from context")
				}
				if fields.requestID != w.Header().Get(requestIDHeader) {
					t.Fatalf("context request ID = %q, response header = %q", fields.requestID, w.Header().Get(requestIDHeader))
				}
				w.WriteHeader(http.StatusNoContent)
			}))

			req := httptest.NewRequest(http.MethodGet, "/test", nil)
			if test.requestID != "" {
				req.Header.Set(requestIDHeader, test.requestID)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			got := rec.Header().Get(requestIDHeader)
			if !validRequestID(got) {
				t.Fatalf("response request ID %q is invalid", got)
			}
			if test.wantSame && got != test.requestID {
				t.Fatalf("response request ID = %q, want %q", got, test.requestID)
			}
			if !test.wantSame && got == test.requestID {
				t.Fatalf("response request ID = %q, want a generated value", got)
			}
		})
	}
}

func TestValidRequestIDBoundsAndCharacters(t *testing.T) {
	tests := []struct {
		name string
		id   string
		want bool
	}{
		{name: "minimum length", id: "a", want: true},
		{name: "maximum length", id: strings.Repeat("a", 64), want: true},
		{name: "allowed punctuation", id: "A-z_09.test", want: true},
		{name: "empty", id: "", want: false},
		{name: "too long", id: strings.Repeat("a", 65), want: false},
		{name: "slash", id: "bad/id", want: false},
		{name: "space", id: "bad id", want: false},
		{name: "non ASCII", id: "café", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validRequestID(test.id); got != test.want {
				t.Fatalf("validRequestID(%q) = %t, want %t", test.id, got, test.want)
			}
		})
	}
}

func TestAccessLogIncludesHealthAndUsesDirectPeer(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := newTestRouter(nil, logger)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "192.0.2.10:4567"
	req.Header.Set("X-Forwarded-For", "198.51.100.20")
	req.Header.Set(requestIDHeader, "health-log-1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("health status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got, want := rec.Header().Get(requestIDHeader), "health-log-1"; got != want {
		t.Fatalf("response request ID = %q, want %q", got, want)
	}

	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
		t.Fatalf("access log is not JSON: %v; output=%q", err, output.String())
	}
	if entry["msg"] != "request completed" || entry["level"] != "INFO" || entry["method"] != http.MethodGet || entry["path"] != "/health" || entry["route"] != "/health" {
		t.Fatalf("access log fields = %#v, want the health request and route", entry)
	}
	if entry["status"] != float64(http.StatusOK) || entry["bytes"] != float64(rec.Body.Len()) {
		t.Fatalf("access log status/bytes = %v/%v, want %d/%d", entry["status"], entry["bytes"], http.StatusOK, rec.Body.Len())
	}
	if entry["remote_addr"] != req.RemoteAddr {
		t.Fatalf("logged remote_addr = %v, want direct peer %q", entry["remote_addr"], req.RemoteAddr)
	}
	if entry["remote_addr"] == req.Header.Get("X-Forwarded-For") {
		t.Fatalf("forwarded address was trusted: %#v", entry)
	}
	if entry["request_id"] != "health-log-1" {
		t.Fatalf("logged request_id = %v, want health-log-1", entry["request_id"])
	}
	if _, exists := entry["user_id"]; exists {
		t.Fatalf("public health access log has an unexpected user_id: %#v", entry)
	}
}

func TestAccessLogSeverityByStatus(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		wantLevel string
	}{
		{name: "success is info", status: http.StatusOK, wantLevel: "INFO"},
		{name: "client error is warn", status: http.StatusBadRequest, wantLevel: "WARN"},
		{name: "server error is error", status: http.StatusInternalServerError, wantLevel: "ERROR"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, nil))
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
			})
			handler := requestIDMiddleware(accessLogMiddleware(logger, next))
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/severity", nil))

			var entry map[string]any
			if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
				t.Fatalf("access log is not JSON: %v; output=%q", err, output.String())
			}
			if entry["level"] != test.wantLevel || entry["status"] != float64(test.status) {
				t.Fatalf("access log level/status = %v/%v, want %s/%d", entry["level"], entry["status"], test.wantLevel, test.status)
			}
		})
	}
}

func TestAccessLogRouteUsesServeMuxPattern(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := newTestRouter(nil, logger)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/wallets/42", nil)
	req.Header.Set(requestIDHeader, "route-1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
		t.Fatalf("access log is not JSON: %v; output=%q", err, output.String())
	}
	if entry["path"] != "/api/v1/wallets/42" || entry["route"] != "/api/v1/wallets/{id}" {
		t.Fatalf("path/route = %v/%v, want /api/v1/wallets/42 and /api/v1/wallets/{id}", entry["path"], entry["route"])
	}
}

func TestAccessLogWriteFailureIsSingleWarnEntry(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	writeErr := errors.New("broken pipe")
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("body"))
	})
	handler := requestIDMiddleware(accessLogMiddleware(logger, next))
	req := httptest.NewRequest(http.MethodGet, "/write-failure", nil)
	req.Header.Set(requestIDHeader, "write-error-1")
	handler.ServeHTTP(&errorResponseWriter{err: writeErr}, req)

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("log lines = %d, want one request entry: %s", len(lines), output.String())
	}
	var entry map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &entry); err != nil {
		t.Fatalf("access log is not JSON: %v", err)
	}
	if entry["level"] != "WARN" || entry["writeError"] != writeErr.Error() {
		t.Fatalf("write failure log level/writeError = %v/%v, want WARN/broken pipe", entry["level"], entry["writeError"])
	}
	if entry["msg"] != "request completed" {
		t.Fatalf("write failure log message = %v, want one access-log entry", entry["msg"])
	}
}

func TestHealthHandlerWriteFailureUsesAccessLog(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	writeErr := errors.New("health write failed")
	handler := accessLogMiddleware(logger, http.HandlerFunc(healthHandler))
	handler.ServeHTTP(&errorResponseWriter{err: writeErr}, httptest.NewRequest(http.MethodGet, "/health", nil))

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("log lines = %d, want one request entry: %s", len(lines), output.String())
	}
	var entry map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &entry); err != nil {
		t.Fatalf("access log is not JSON: %v", err)
	}
	if entry["level"] != "WARN" || !strings.Contains(entry["writeError"].(string), writeErr.Error()) {
		t.Fatalf("health write failure log = %#v, want WARN with writeError", entry)
	}
}

func TestRequestIDDoesNotChangeJSONErrorBody(t *testing.T) {
	handler := newTestRouter(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set(requestIDHeader, "auth-error-1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	const want = "{\"error\":{\"code\":\"UNAUTHENTICATED\",\"message\":\"unauthenticated\"}}\n"
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if got := rec.Body.String(); got != want {
		t.Fatalf("JSON error body changed:\n got: %q\nwant: %q", got, want)
	}
	if got := rec.Header().Get(requestIDHeader); got != "auth-error-1" {
		t.Fatalf("response request ID = %q, want auth-error-1", got)
	}
	if strings.Contains(rec.Body.String(), "requestId") {
		t.Fatalf("JSON error body contains requestId: %s", rec.Body.String())
	}
}

func TestAccessLogIncludesAuthenticatedUserID(t *testing.T) {
	ctx := context.Background()
	repo := user.NewInMemoryRepository()
	created, err := repo.Create(ctx, user.User{Email: "access-log@example.com"})
	if err != nil {
		t.Fatalf("create test user: %v", err)
	}
	rawToken := "access-log-test-token"
	tokenHash := sha256.Sum256([]byte(rawToken))
	_, err = repo.CreateSession(ctx, user.UserSession{
		UserID:    created.ID,
		TokenHash: base64.RawURLEncoding.EncodeToString(tokenHash[:]),
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("create test session: %v", err)
	}

	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := newTestRouter(repo, logger)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set("Authorization", "Bearer "+rawToken)
	req.Header.Set(requestIDHeader, "authenticated-log-1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("current-user status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
		t.Fatalf("access log is not JSON: %v; output=%q", err, output.String())
	}
	if entry["user_id"] != float64(created.ID) {
		t.Fatalf("logged user_id = %v, want %d", entry["user_id"], created.ID)
	}
	if entry["request_id"] != "authenticated-log-1" {
		t.Fatalf("logged request_id = %v, want authenticated-log-1", entry["request_id"])
	}
}

func TestPanicRecovery(t *testing.T) {
	const internalErrorBody = "{\"error\":{\"code\":\"INTERNAL_SERVER_ERROR\",\"message\":\"internal error\"}}\n"
	tests := []struct {
		name       string
		handler    http.Handler
		wantStatus int
		wantBody   string
	}{
		{
			name: "before response starts writes internal error envelope",
			handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				panic("test panic")
			}),
			wantStatus: http.StatusInternalServerError,
			wantBody:   internalErrorBody,
		},
		{
			name: "after partial write preserves response",
			handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusAccepted)
				_, _ = w.Write([]byte("partial"))
				panic("test panic")
			}),
			wantStatus: http.StatusAccepted,
			wantBody:   "partial",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, nil))
			handler := requestIDMiddleware(accessLogMiddleware(logger, panicRecoveryMiddleware(test.handler)))
			req := httptest.NewRequest(http.MethodGet, "/panic", nil)
			req.Header.Set(requestIDHeader, "panic-1")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%q", rec.Code, test.wantStatus, rec.Body.String())
			}
			if rec.Body.String() != test.wantBody {
				t.Fatalf("body = %q, want %q", rec.Body.String(), test.wantBody)
			}

			lines := strings.Split(strings.TrimSpace(output.String()), "\n")
			if len(lines) != 1 {
				t.Fatalf("log lines = %d, want one request entry: %s", len(lines), output.String())
			}
			var entry map[string]any
			if err := json.Unmarshal([]byte(lines[0]), &entry); err != nil {
				t.Fatalf("access log is not JSON: %v", err)
			}
			if entry["msg"] != "request completed" || entry["level"] != "ERROR" {
				t.Fatalf("panic access log message/level = %v/%v, want request completed/ERROR", entry["msg"], entry["level"])
			}
			if entry["status"] != float64(test.wantStatus) || entry["bytes"] != float64(len(test.wantBody)) {
				t.Fatalf("panic access log status/bytes = %v/%v, want %d/%d", entry["status"], entry["bytes"], test.wantStatus, len(test.wantBody))
			}
			if entry["panic"] != "test panic" || entry["stack"] == "" || entry["request_id"] != "panic-1" {
				t.Fatalf("panic access log metadata = %#v", entry)
			}
		})
	}
}

func TestPanicRecoveryRepanicsErrAbortHandler(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := accessLogMiddleware(logger, panicRecoveryMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	})))
	rec := httptest.NewRecorder()

	var recovered any
	func() {
		defer func() { recovered = recover() }()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/abort", nil))
	}()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("recovered panic = %#v, want the same http.ErrAbortHandler sentinel", recovered)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("abort recovery wrote a body: %q", rec.Body.String())
	}
	if strings.Contains(output.String(), "panic recovered") {
		t.Fatalf("http.ErrAbortHandler was logged as an application panic: %s", output.String())
	}
}

func TestDurationMillisecondsUsesMicrosecondPrecision(t *testing.T) {
	if got, want := durationMilliseconds(1234*time.Microsecond), 1.234; got != want {
		t.Fatalf("durationMilliseconds(1234µs) = %v, want %v", got, want)
	}
}

func TestResponseRecorderCapturesFirstStatusAndBytes(t *testing.T) {
	underlying := httptest.NewRecorder()
	recorder := &responseRecorder{ResponseWriter: underlying}
	recorder.WriteHeader(http.StatusCreated)
	recorder.WriteHeader(http.StatusInternalServerError)
	if n, err := recorder.Write([]byte("ok")); err != nil || n != 2 {
		t.Fatalf("Write = %d, %v, want 2, nil", n, err)
	}
	if underlying.Code != http.StatusCreated || recorder.statusCode() != http.StatusCreated {
		t.Fatalf("status = underlying %d, recorded %d, want %d", underlying.Code, recorder.statusCode(), http.StatusCreated)
	}
	if recorder.bytesWritten != 2 || underlying.Body.String() != "ok" {
		t.Fatalf("bytes/body = %d/%q, want 2/ok", recorder.bytesWritten, underlying.Body.String())
	}
}

func TestResponseRecorderCapturesWriteError(t *testing.T) {
	writeErr := errors.New("write failed")
	underlying := &errorResponseWriter{err: writeErr}
	recorder := &responseRecorder{ResponseWriter: underlying}
	n, err := recorder.Write([]byte("body"))
	if n != 1 || !errors.Is(err, writeErr) {
		t.Fatalf("Write = %d, %v, want 1 and the underlying error", n, err)
	}
	if recorder.bytesWritten != 1 || !errors.Is(recorder.writeErr, writeErr) {
		t.Fatalf("recorded bytes/error = %d/%v, want 1 and the first write error", recorder.bytesWritten, recorder.writeErr)
	}
	recorder.recordWriteError(errors.New("later error"))
	if !errors.Is(recorder.writeErr, writeErr) {
		t.Fatalf("writeErr = %v, want the first error %v", recorder.writeErr, writeErr)
	}
}

type errorResponseWriter struct {
	header http.Header
	status int
	err    error
}

func (w *errorResponseWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *errorResponseWriter) WriteHeader(status int) { w.status = status }

func (w *errorResponseWriter) Write([]byte) (int, error) { return 1, w.err }

func TestRequestIDAndAccessLogPreserveUnmatchedPath404(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := newTestRouter(nil, logger)
	req := httptest.NewRequest(http.MethodGet, "/not-registered", nil)
	req.Header.Set(requestIDHeader, "unmatched-1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("unmatched route status = %d, want %d", rec.Code, http.StatusNotFound)
	}
	if got, want := rec.Body.String(), "404 page not found\n"; got != want {
		t.Fatalf("unmatched route body = %q, want %q", got, want)
	}
	if got := rec.Header().Get(requestIDHeader); got != "unmatched-1" {
		t.Fatalf("unmatched route request ID = %q, want unmatched-1", got)
	}
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
		t.Fatalf("unmatched route log is not JSON: %v; output=%q", err, output.String())
	}
	if entry["status"] != float64(http.StatusNotFound) || entry["path"] != "/not-registered" {
		t.Fatalf("unmatched access log = %#v, want path and 404 status", entry)
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
