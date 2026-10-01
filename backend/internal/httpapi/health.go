package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

const readinessTimeout = 2 * time.Second

type ReadinessChecker interface {
	Check(ctx context.Context) error
}

type healthResponse struct {
	Status string `json:"status"`
}

// healthHandler is dependency-free liveness. The legacy /health route remains
// registered as an alias to this handler.
func healthHandler(w http.ResponseWriter, _ *http.Request) {
	if err := writeJSON(w, http.StatusOK, healthResponse{Status: "ok"}); err != nil {
		recordResponseWriteError(w, err)
	}
}

func readyHandler(logger *slog.Logger, checker ReadinessChecker, timeout time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()

		if err := checker.Check(ctx); err != nil {
			requestID := r.Header.Get(requestIDHeader)
			if fields, ok := requestLogFieldsFromContext(r.Context()); ok {
				requestID = fields.requestID
			}
			logger.ErrorContext(r.Context(), "readiness check failed", "request_id", requestID, "error", err)
			writeError(w, http.StatusServiceUnavailable, CodeServiceUnavailable, "not ready", nil)
			return
		}

		if err := writeJSON(w, http.StatusOK, healthResponse{Status: "ok"}); err != nil {
			recordResponseWriteError(w, err)
		}
	}
}
