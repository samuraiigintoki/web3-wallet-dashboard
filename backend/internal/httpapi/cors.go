package httpapi

// Cross-origin access, decided once and by an allowlist.
//
// The dashboard is served from its own origin so that a static host can cache
// it and a bad deploy of the frontend cannot take the API down with it. That
// makes every call from the browser a cross-origin request, and a cross-origin
// request needs an answer the browser will accept. What this file decides is
// which origins get one.
//
// The rules, and why each one is written the way it is:
//
//   - The allowlist is exact. An origin is scheme, host and port, and it is
//     compared as a whole string. There is no prefix match, no subdomain
//     wildcard, and no `*`: this API carries a bearer token, so an origin that
//     is not on the list must never be told its reads are allowed.
//   - Nothing is allowed unless it was configured. An empty allowlist, which is
//     what an unconfigured deployment has, answers no cross-origin request at
//     all. Local development is unaffected because the Vite dev server proxies
//     `/api` and the browser therefore makes same-origin requests.
//   - Each configured origin is validated at startup, and a bad one is a startup
//     failure. A typo that silently allowed nothing would be a deployment that
//     looks healthy and answers 403 to every browser, and a typo that was
//     quietly widened to a prefix match would be worse.
//   - Credentials are never allowed. Sessions are bearer tokens in an
//     `Authorization` header, not cookies, so no response needs
//     `Access-Control-Allow-Credentials`, and omitting it keeps a browser from
//     ever attaching ambient credentials to a cross-origin call.
//   - A preflight is answered before the rate limiter, the access log and the
//     request ID middleware, and never reaches a handler. A browser sends one
//     before it sends the call the user asked for, so counting it against the
//     user's budget would charge them twice for one action, and a preflight has
//     no body, no credential and nothing to log.
//   - `Vary: Origin` is set on every response this middleware touches. The
//     allow-origin header differs by request, so a cache that ignores the header
//     would hand one origin's answer to another.

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// The most origins a single deployment may allow.
//
// A deployment has one frontend, and a preview environment adds one more. A
// list longer than this is a configuration mistake rather than a need, and
// bounding it means the memory and the comparison cost of the allowlist are
// fixed rather than whatever a leaked environment variable says.
const maxCORSOrigins = 8

// CORSPolicy is the set of browser origins this API answers cross-origin.
//
// The zero value allows nothing, which is the right default: a policy has to be
// configured deliberately, and forgetting to configure one fails closed.
type CORSPolicy struct {
	origins map[string]struct{}
}

// ParseCORSOrigins reads the configured allowlist, or refuses it.
//
// The input is the raw environment value: a comma separated list, empty meaning
// nothing is allowed. Every entry is validated rather than trusted, because this
// value decides who may read authenticated responses.
func ParseCORSOrigins(raw string) (CORSPolicy, error) {
	policy := CORSPolicy{origins: make(map[string]struct{})}

	for _, entry := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(entry)

		if origin == "" {
			continue
		}

		if err := validateOrigin(origin); err != nil {
			return CORSPolicy{}, err
		}

		if _, duplicate := policy.origins[origin]; duplicate {
			continue
		}

		if len(policy.origins) == maxCORSOrigins {
			return CORSPolicy{}, fmt.Errorf(
				"CORS_ALLOWED_ORIGINS lists more than %d origins, which this API does not support",
				maxCORSOrigins,
			)
		}

		policy.origins[origin] = struct{}{}
	}

	return policy, nil
}

// validateOrigin accepts exactly one shape: scheme, host, optional port.
//
// A trailing slash, a path, a query, a fragment, user information or a wildcard
// is refused by name. Each of those is a value somebody writes expecting it to
// work: `https://app.example.com/` is what a browser shows, and browsers send
// `https://app.example.com` in the Origin header, so accepting the slash would
// be accepting a value that can never match.
func validateOrigin(origin string) error {
	if origin == "*" {
		return fmt.Errorf("CORS_ALLOWED_ORIGINS must name origins, not *: this API carries a bearer token")
	}

	if strings.ContainsAny(origin, "*?#") {
		return fmt.Errorf("CORS_ALLOWED_ORIGINS entry %q contains a wildcard or a query, which is not an origin", origin)
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return fmt.Errorf("CORS_ALLOWED_ORIGINS entry %q is not a URL: %w", origin, err)
	}

	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return fmt.Errorf("CORS_ALLOWED_ORIGINS entry %q must be an http or https origin", origin)
	}

	if parsed.Scheme == "http" && !loopbackHost(parsed.Hostname()) {
		return fmt.Errorf(
			"CORS_ALLOWED_ORIGINS entry %q uses http; only https origins are allowed outside localhost",
			origin,
		)
	}

	if parsed.Host == "" || parsed.Hostname() == "" {
		return fmt.Errorf("CORS_ALLOWED_ORIGINS entry %q has no host", origin)
	}

	if parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return fmt.Errorf(
			"CORS_ALLOWED_ORIGINS entry %q must be scheme://host[:port] with nothing after the host",
			origin,
		)
	}

	// An origin is compared as a string, so it has to be the canonical string a
	// browser sends: lower case scheme and host, no explicit default port.
	if parsed.Scheme != strings.ToLower(parsed.Scheme) ||
		parsed.Host != strings.ToLower(parsed.Host) ||
		(parsed.Scheme == "https" && strings.HasSuffix(parsed.Host, ":443")) ||
		(parsed.Scheme == "http" && strings.HasSuffix(parsed.Host, ":80")) {
		return fmt.Errorf(
			"CORS_ALLOWED_ORIGINS entry %q is not in canonical form: use lower case and omit the default port",
			origin,
		)
	}

	return nil
}

func loopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

// Allows reports whether one Origin header value is on the allowlist.
func (p CORSPolicy) Allows(origin string) bool {
	if origin == "" || len(p.origins) == 0 {
		return false
	}

	_, allowed := p.origins[origin]
	return allowed
}

// Len is the number of allowed origins, for a startup log line.
func (p CORSPolicy) Len() int {
	return len(p.origins)
}

// The methods and headers this API actually answers.
//
// These are named rather than reflected from the request: reflecting
// `Access-Control-Request-Headers` would let any origin ask for any header, and
// the point of a policy is that the answer does not depend on what was asked.
const (
	corsAllowedMethods = "GET, POST, PATCH, DELETE, OPTIONS"
	// Authorization carries the session, Content-Type is the JSON body, and
	// X-Request-ID is the client's own correlation id, which the API accepts.
	corsAllowedHeaders = "Authorization, Content-Type, X-Request-ID"
	// The client reads these back off the response: the request id for support,
	// and Retry-After so a rate-limited screen can say when to try again.
	corsExposedHeaders = "X-Request-ID, Retry-After"
	// Ten minutes. Capping how often a browser re-asks keeps preflights off the
	// hot path without making a revoked origin linger for a whole session.
	corsMaxAge = "600"
)

// WithCORS answers preflights and marks allowed cross-origin responses.
//
// It wraps the whole router rather than sitting inside it, so a preflight is
// decided before the rate limiter and before any handler, and so a route added
// later cannot forget to be covered by it.
func WithCORS(next http.Handler, policy CORSPolicy) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		// Not a cross-origin request: a curl, a health probe, an internal call.
		// Nothing is added, and the answer does not vary by origin.
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}

		// The response to this request depends on the Origin header, whether or
		// not the origin is allowed, so any shared cache has to be told.
		w.Header().Add("Vary", "Origin")

		allowed := policy.Allows(origin)

		if allowed {
			// Echoed, never `*`: with an echo the browser's own origin check is
			// an exact match against a value this server chose.
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", corsExposedHeaders)
		}

		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			// A preflight is refused explicitly rather than answered without
			// headers, so a misconfigured origin shows up in a log or in curl as
			// a 403 instead of as a mystery in the browser console.
			if !allowed {
				w.WriteHeader(http.StatusForbidden)
				return
			}

			w.Header().Set("Access-Control-Allow-Methods", corsAllowedMethods)
			w.Header().Set("Access-Control-Allow-Headers", corsAllowedHeaders)
			w.Header().Set("Access-Control-Max-Age", corsMaxAge)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// An actual request from an origin that is not allowed still runs: the
		// server is not the enforcement point for a token check, and adding no
		// header is what makes the browser withhold the response. Refusing it
		// here would also change what an uncredentialed curl sees depending on a
		// header it never set.
		next.ServeHTTP(w, r)
	})
}
