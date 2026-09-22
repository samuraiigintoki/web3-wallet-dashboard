package httpapi

import (
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func NewRouter(walletSvc *wallet.Service, userSvc *user.Service, chainSvc *chain.Service) http.Handler {
	mux := http.NewServeMux()
	h := NewHandler(walletSvc, userSvc, chainSvc)

	// health
	mux.HandleFunc("GET /health", healthHandler)

	// public: chains (no auth)
	mux.HandleFunc("GET /api/v1/chains", h.listChains)

	// wallets
	mux.HandleFunc("POST /api/v1/wallets", h.createWallet)
	mux.HandleFunc("GET /api/v1/wallets/{id}", h.getWallet)
	mux.HandleFunc("GET /api/v1/wallets", h.listWallets)
	mux.HandleFunc("PATCH /api/v1/wallets/{id}", h.updateWallet)
	mux.HandleFunc("DELETE /api/v1/wallets/{id}", h.deleteWallet)

	// authentication
	requireAuth := RequireAuth(userSvc)
	mux.HandleFunc("POST /api/v1/auth/register", h.registerUser)
	mux.HandleFunc("POST /api/v1/auth/login", h.loginUser)
	mux.HandleFunc("POST /api/v1/auth/logout", h.logoutUser)
	mux.Handle("GET /api/v1/users/me", requireAuth(http.HandlerFunc(h.getCurrentUser)))

	return mux
}
