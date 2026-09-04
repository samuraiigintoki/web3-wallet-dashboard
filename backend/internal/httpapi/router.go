package httpapi

import (
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func NewRouter(walletSvc *wallet.Service) http.Handler {
	mux := http.NewServeMux()
	h := NewHandler(walletSvc)

	mux.HandleFunc("GET /health", healthHandler)
	mux.HandleFunc("POST /api/v1/wallets", h.createWallet)
	return mux
}
