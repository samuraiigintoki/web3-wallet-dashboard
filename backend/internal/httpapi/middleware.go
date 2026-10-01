package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"time"
)

const requestIDHeader = "X-Request-ID"

type requestLogContextKey struct{}

type requestLogFields struct {
	requestID                string
	userID                   int64
	hasUserID                bool
	requestIDGenerationError string
	panicValue               string
	panicStack               string
}

var requestIDFallbackCounter atomic.Uint64

func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get(requestIDHeader)
		var generationErr error
		if !validRequestID(requestID) {
			requestID, generationErr = generateRequestID()
		}

		fields := &requestLogFields{requestID: requestID}
		if generationErr != nil {
			fields.requestIDGenerationError = generationErr.Error()
		}
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

func generateRequestID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		fallback := fmt.Sprintf("fallback-%x-%x", time.Now().UTC().UnixNano(), requestIDFallbackCounter.Add(1))
		return fallback, err
	}

	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(raw[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:]), nil
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
			status := response.statusCode()
			route := r.Pattern
			if _, path, hasMethod := strings.Cut(route, " "); hasMethod {
				route = path
			}

			attributes := []any{
				"method", r.Method,
				"path", r.URL.Path,
				"route", route,
				"status", status,
				"bytes", response.bytesWritten,
				"duration_ms", durationMilliseconds(time.Since(started)),
				"remote_addr", r.RemoteAddr,
			}
			level := slog.LevelInfo
			if status >= http.StatusInternalServerError {
				level = slog.LevelError
			} else if status >= http.StatusBadRequest {
				level = slog.LevelWarn
			}
			if response.writeErr != nil {
				attributes = append(attributes, "write_error", response.writeErr.Error())
				if level < slog.LevelWarn {
					level = slog.LevelWarn
				}
			}
			if fields, ok := requestLogFieldsFromContext(r.Context()); ok {
				attributes = append(attributes, "request_id", fields.requestID)
				if fields.hasUserID {
					attributes = append(attributes, "user_id", fields.userID)
				}
				if fields.requestIDGenerationError != "" {
					attributes = append(attributes, "request_id_generation_error", fields.requestIDGenerationError)
					level = slog.LevelError
				}
				if fields.panicValue != "" {
					attributes = append(attributes, "panic", fields.panicValue, "stack", fields.panicStack)
					level = slog.LevelError
				}
			}
			logger.Log(r.Context(), level, "request completed", attributes...)
		}()
		next.ServeHTTP(response, r)
	})
}

func durationMilliseconds(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}

func panicRecoveryMiddleware(next http.Handler) http.Handler {
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

			if fields, ok := requestLogFieldsFromContext(r.Context()); ok {
				fields.panicValue = fmt.Sprint(recovered)
				fields.panicStack = string(debug.Stack())
			}
			if response, ok := w.(*responseRecorder); ok && response.wroteHeader {
				return
			}
			writeError(w, http.StatusInternalServerError, CodeInternalError, "internal error", nil)
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
