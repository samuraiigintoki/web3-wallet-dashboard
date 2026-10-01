package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"sync/atomic"
	"time"
)

const requestIDHeader = "X-Request-ID"

type requestLogContextKey struct{}

type requestLogFields struct {
	requestID string
	userID    int64
	hasUserID bool
}

var requestIDFallbackCounter atomic.Uint64

func requestIDMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get(requestIDHeader)
		if !validRequestID(requestID) {
			requestID = generateRequestID(logger)
		}

		fields := &requestLogFields{requestID: requestID}
		ctx := context.WithValue(r.Context(), requestLogContextKey{}, fields)
		w.Header().Set(requestIDHeader, requestID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func validRequestID(requestID string) bool {
	if len(requestID) == 0 || len(requestID) > 64 {
		return false
	}
	for i := 0; i < len(requestID); i++ {
		ch := requestID[i]
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' {
			continue
		}
		return false
	}
	return true
}

func generateRequestID(logger *slog.Logger) string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		logger.Error("failed to generate request ID", "error", err)
		return fmt.Sprintf("fallback-%x-%x", time.Now().UTC().UnixNano(), requestIDFallbackCounter.Add(1))
	}

	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(raw[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:])
}

func requestLogFieldsFromContext(ctx context.Context) (*requestLogFields, bool) {
	fields, ok := ctx.Value(requestLogContextKey{}).(*requestLogFields)
	return fields, ok && fields != nil
}

func captureAuthenticatedUserID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fields, ok := requestLogFieldsFromContext(r.Context()); ok {
			if authenticatedUser, ok := UserFromContext(r.Context()); ok {
				fields.userID = authenticatedUser.ID
				fields.hasUserID = true
			}
		}
		next.ServeHTTP(w, r)
	})
}

func accessLogMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		response := &responseRecorder{ResponseWriter: w}
		defer func() {
			attributes := []any{
				"method", r.Method,
				"path", r.URL.Path,
				"status", response.statusCode(),
				"bytes", response.bytesWritten,
				"duration_ms", time.Since(started).Milliseconds(),
				"remote_addr", r.RemoteAddr,
			}
			if fields, ok := requestLogFieldsFromContext(r.Context()); ok {
				attributes = append(attributes, "request_id", fields.requestID)
				if fields.hasUserID {
					attributes = append(attributes, "user_id", fields.userID)
				}
			}
			if response.writeErr != nil {
				logger.Error("response write failed", "request_id", requestIDFromContext(r.Context()), "error", response.writeErr)
			}
			logger.Info("request completed", attributes...)
		}()
		next.ServeHTTP(response, r)
	})
}

func requestIDFromContext(ctx context.Context) string {
	fields, ok := requestLogFieldsFromContext(ctx)
	if !ok {
		return ""
	}
	return fields.requestID
}

func panicRecoveryMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if recovered == http.ErrAbortHandler {
				markRequestAborted(w)
				panic(recovered)
			}

			logger.Error(
				"panic recovered",
				"request_id", requestIDFromContext(r.Context()),
				"panic", fmt.Sprint(recovered),
				"stack", string(debug.Stack()),
			)
			markRequestAborted(w)
			panic(http.ErrAbortHandler)
		}()

		next.ServeHTTP(w, r)
	})
}

func markRequestAborted(w http.ResponseWriter) {
	if response, ok := w.(*responseRecorder); ok && !response.wroteHeader {
		response.aborted = true
	}
}

func recordResponseWriteError(w http.ResponseWriter, err error) {
	if recorder, ok := w.(interface{ recordWriteError(error) }); ok {
		recorder.recordWriteError(err)
	}
}

type responseRecorder struct {
	http.ResponseWriter
	status       int
	bytesWritten int64
	writeErr     error
	wroteHeader  bool
	aborted      bool
}

func (r *responseRecorder) WriteHeader(status int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	n, err := r.ResponseWriter.Write(body)
	r.bytesWritten += int64(n)
	if err != nil {
		r.recordWriteError(err)
	}
	return n, err
}

func (r *responseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (r *responseRecorder) statusCode() int {
	if !r.wroteHeader {
		if r.aborted {
			return 0
		}
		return http.StatusOK
	}
	return r.status
}

func (r *responseRecorder) recordWriteError(err error) {
	if err != nil && r.writeErr == nil {
		r.writeErr = err
	}
}
