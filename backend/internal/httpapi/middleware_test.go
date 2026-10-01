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
			handler := requestIDMiddleware(testLogger(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	if entry["msg"] != "request completed" || entry["method"] != http.MethodGet || entry["path"] != "/health" {
		t.Fatalf("access log fields = %#v, want the health request", entry)
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

func TestPanicRecoveryLogsAndAbortsWithoutWritingResponse(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := requestIDMiddleware(logger, accessLogMiddleware(logger, panicRecoveryMiddleware(logger, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("test panic")
	}))))
	req := httptest.NewRequest(http.MethodGet, "/panic", nil)
	req.Header.Set(requestIDHeader, "panic-1")
	rec := httptest.NewRecorder()

	var recovered any
	func() {
		defer func() { recovered = recover() }()
		handler.ServeHTTP(rec, req)
	}()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("recovered panic = %#v, want http.ErrAbortHandler", recovered)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("panic recovery wrote a response body: %q", rec.Body.String())
	}

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("log lines = %d, want panic and access entries: %s", len(lines), output.String())
	}
	var panicEntry, accessEntry map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &panicEntry); err != nil {
		t.Fatalf("panic log is not JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &accessEntry); err != nil {
		t.Fatalf("access log is not JSON: %v", err)
	}
	if panicEntry["msg"] != "panic recovered" || panicEntry["panic"] != "test panic" || panicEntry["stack"] == "" {
		t.Fatalf("panic log fields = %#v", panicEntry)
	}
	if panicEntry["request_id"] != "panic-1" {
		t.Fatalf("panic log request_id = %v, want panic-1", panicEntry["request_id"])
	}
	if accessEntry["msg"] != "request completed" || accessEntry["status"] != float64(0) || accessEntry["bytes"] != float64(0) {
		t.Fatalf("aborted access log fields = %#v, want status=0 and bytes=0", accessEntry)
	}
}

func TestPanicRecoveryRepanicsErrAbortHandler(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := accessLogMiddleware(logger, panicRecoveryMiddleware(logger, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
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
