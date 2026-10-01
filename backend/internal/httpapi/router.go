package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func NewRouter(walletSvc *wallet.Service, userSvc *user.Service, chainSvc *chain.Service, contractSvc *contract.Service, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	h := NewHandler(walletSvc, userSvc, chainSvc, contractSvc)

	// health
	mux.HandleFunc("GET /health", healthHandler)

	// public: chains (no auth)
	mux.HandleFunc("GET /api/v1/chains", h.listChains)

	// Authentication adds the user id to the request's access-log metadata after
	// validating the bearer token.
	requireAuth := RequireAuth(userSvc)
	authenticated := func(next http.Handler) http.Handler {
		return requireAuth(captureAuthenticatedUserID(next))
	}
	mux.HandleFunc("POST /api/v1/auth/register", h.registerUser)
	mux.HandleFunc("POST /api/v1/auth/login", h.loginUser)
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

	return requestIDMiddleware(logger, accessLogMiddleware(logger, panicRecoveryMiddleware(logger, mux)))
}
