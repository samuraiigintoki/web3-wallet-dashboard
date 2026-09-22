package httpapi

import (
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
)

func (h *Handler) listChains(w http.ResponseWriter, r *http.Request) {
	chains, err := h.chainSvc.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}
	if chains == nil {
		chains = make([]chain.Chain, 0)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": chains})
}
