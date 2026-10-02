package httpapi

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"time"
)

const retryAfterHeader = "Retry-After"

// healthPaths carry no rate limiting on either tier. Probes are infrastructure
// traffic, not callers.
var healthPaths = map[string]struct{}{
	"/health":       {},
	"/health/live":  {},
	"/health/ready": {},
}

func isHealthPath(path string) bool {
	_, ok := healthPaths[path]
	return ok
}

// RateLimiter decides whether the caller identified by key may proceed. The
// retryAfter returned with a denial is how long that caller waits before one
// unit of budget is available again.
//
// Implementations must be safe for concurrent use. Handlers never see this
// type; only the rate-limit middleware calls it.
type RateLimiter interface {
	Allow(key string) (allowed bool, retryAfter time.Duration)
}

// rateLimit wraps a handler with one tier of a limiter. The global tier uses it
// once around the whole mux, so a request is counted before the router matches
// a route and before authentication runs. The strict tier uses it around the
// two credential routes. Health paths are skipped here rather than at the route
// table, because the global wrap sits above route matching.
func rateLimit(limiter RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isHealthPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}

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

// rateLimitKey keys every tier on the client address alone. Keying on the
// authenticated user id instead would require the limiter to run after
// requireAuth, which leaves a flood of invalid tokens queued on the session
// lookup before anything counts it. The address is known before routing, so one
// key namespace covers the whole API.
func rateLimitKey(r *http.Request) string {
	return clientAddress(r.RemoteAddr)
}

// clientAddress drops the source port. Keying on the full RemoteAddr would give
// every new connection its own bucket and disable the limiter.
func clientAddress(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

// retryAfterSeconds formats delay-seconds for the Retry-After header. It rounds
// up: the header is a non-negative integer, and zero would tell the client to
// retry immediately.
func retryAfterSeconds(retryAfter time.Duration) string {
	seconds := int(math.Ceil(retryAfter.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	return strconv.Itoa(seconds)
}
