package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func NewRouter(walletSvc *wallet.Service, userSvc *user.Service, chainSvc *chain.Service, contractSvc *contract.Service, logger *slog.Logger, readinessChecker ReadinessChecker, globalLimiter RateLimiter, authLimiter RateLimiter) http.Handler {
	mux := http.NewServeMux()
	h := NewHandler(walletSvc, userSvc, chainSvc, contractSvc)

	// Liveness never consults dependencies; /health remains a compatibility alias.
	// Health probes are infrastructure traffic and no limiter counts them.
	mux.HandleFunc("GET /health/live", healthHandler)
	mux.HandleFunc("GET /health", healthHandler)
	mux.Handle("GET /health/ready", readyHandler(logger, readinessChecker, readinessTimeout))

	// The strict tier wraps the two brute-force targets, on top of the global
	// tier that already wrapped the whole mux below.
	auth := rateLimit(authLimiter)

	// public: chains (no auth)
	mux.HandleFunc("GET /api/v1/chains", h.listChains)

	// Authentication adds the user id to the request's access-log metadata after
	// validating the bearer token.
	requireAuth := RequireAuth(userSvc)
	authenticated := func(next http.Handler) http.Handler {
		return requireAuth(captureAuthenticatedUserID(next))
	}
	mux.Handle("POST /api/v1/auth/register", auth(http.HandlerFunc(h.registerUser)))
	mux.Handle("POST /api/v1/auth/login", auth(http.HandlerFunc(h.loginUser)))
	mux.HandleFunc("POST /api/v1/auth/logout", h.logoutUser)
	mux.Handle("POST /api/v1/auth/revoke-all", authenticated(http.HandlerFunc(h.revokeAllSessions)))
	mux.Handle("GET /api/v1/users/me", authenticated(http.HandlerFunc(h.getCurrentUser)))

	// wallets (owner-scoped: every route requires the authenticated user)
	mux.Handle("POST /api/v1/wallets", authenticated(http.HandlerFunc(h.createWallet)))
	mux.Handle("GET /api/v1/wallets", authenticated(http.HandlerFunc(h.listWallets)))
	mux.Handle("GET /api/v1/wallets/{id}", authenticated(http.HandlerFunc(h.getWallet)))
	mux.Handle("PATCH /api/v1/wallets/{id}", authenticated(http.HandlerFunc(h.updateWallet)))
	mux.Handle("DELETE /api/v1/wallets/{id}", authenticated(http.HandlerFunc(h.deleteWallet)))

	// tracked contracts
	mux.Handle("POST /api/v1/contracts", authenticated(http.HandlerFunc(h.createContract)))
	mux.Handle("GET /api/v1/contracts", authenticated(http.HandlerFunc(h.listContracts)))
	mux.Handle("GET /api/v1/contracts/{id}", authenticated(http.HandlerFunc(h.getContract)))
	mux.Handle("PATCH /api/v1/contracts/{id}", authenticated(http.HandlerFunc(h.updateContract)))
	mux.Handle("DELETE /api/v1/contracts/{id}", authenticated(http.HandlerFunc(h.deleteContract)))

	// The global tier is one chain-wide wrap, above route matching and above
	// authentication, so an invalid token is counted before requireAuth reaches
	// the session lookup and an unmatched path is counted too. The health paths
	// skip it inside the middleware.
	return requestIDMiddleware(accessLogMiddleware(logger, rateLimit(globalLimiter)(panicRecoveryMiddleware(mux))))
}
