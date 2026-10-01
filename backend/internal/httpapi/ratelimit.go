package httpapi

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"time"
)

const retryAfterHeader = "Retry-After"

// RateLimiter decides whether the caller identified by key may proceed. The
// retryAfter returned with a denial is how long that caller waits before one
// unit of budget is available again.
//
// Implementations must be safe for concurrent use. Handlers never see this
// type; only the rate-limit middleware calls it.
type RateLimiter interface {
	Allow(key string) (allowed bool, retryAfter time.Duration)
}

// rateLimit wraps one handler with one tier of a limiter. The router applies
// it per route rather than around the whole mux, because the authenticated key
// only exists once requireAuth has run for the request.
func rateLimit(limiter RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			allowed, retryAfter := limiter.Allow(rateLimitKey(r))

			if !allowed {
				w.Header().Set(retryAfterHeader, retryAfterSeconds(retryAfter))
				writeError(w, http.StatusTooManyRequests, CodeRateLimited, "too many requests", nil)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// rateLimitKey is the hybrid key: authenticated routes bucket per user, so
// callers sharing one client address do not spend each other's budget, while
// unauthenticated routes have no user to name and bucket per client address.
// The prefixes keep the two namespaces from colliding.
func rateLimitKey(r *http.Request) string {
	if authenticated, ok := UserFromContext(r.Context()); ok {
		return "user:" + strconv.FormatInt(authenticated.ID, 10)
	}
	return "ip:" + clientAddress(r.RemoteAddr)
}

// clientAddress drops the source port. Keying on the full RemoteAddr would
// give every new connection its own bucket and disable the limiter.
func clientAddress(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

// retryAfterSeconds formats delay-seconds for the Retry-After header. It
// rounds up: the header is a non-negative integer, and zero would tell the
// client to retry immediately.
func retryAfterSeconds(retryAfter time.Duration) string {
	seconds := int(math.Ceil(retryAfter.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	return strconv.Itoa(seconds)
}
