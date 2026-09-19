package httpapi

import (
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func NewRouter(walletSvc *wallet.Service, userServices ...*user.Service) http.Handler {
	var userSvc *user.Service
	if len(userServices) > 0 {
		userSvc = userServices[0]
	}

	mux := http.NewServeMux()
	h := NewHandler(walletSvc, userSvc)
	// requireAuth := RequireAuth(userSvc)

	// health
	mux.HandleFunc("GET /health", healthHandler)

	// wallets
	mux.HandleFunc("POST /api/v1/wallets", h.createWallet)
	mux.HandleFunc("GET /api/v1/wallets/{id}", h.getWallet)
	mux.HandleFunc("GET /api/v1/wallets", h.listWallets)
	mux.HandleFunc("PATCH /api/v1/wallets/{id}", h.updateWallet)
	mux.HandleFunc("DELETE /api/v1/wallets/{id}", h.deleteWallet)

	if userSvc != nil {
		requireAuth := RequireAuth(userSvc)

		mux.HandleFunc("POST /api/v1/auth/register", h.registerUser)
		mux.HandleFunc("POST /api/v1/auth/login", h.loginUser)
		mux.HandleFunc("POST /api/v1/auth/logout", h.logoutUser)
		mux.Handle("GET /api/v1/users/me", requireAuth(http.HandlerFunc(h.getCurrentUser)))
	}
	
	return mux
}
