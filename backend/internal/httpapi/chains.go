package httpapi

import (
	"net/http"
)

type ChainResponse struct {
	ChainID   int64  `json:"chainId"`
	Name      string `json:"name"`
	Symbol    string `json:"symbol"`
	IsTestnet bool   `json:"isTestnet"`
}

type ChainResponseEnvelope struct {
	Data []ChainResponse `json:"data"`
}

func (h *Handler) listChains(w http.ResponseWriter, r *http.Request) {
	chains, err := h.chainSvc.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	resp := make([]ChainResponse, 0, len(chains))
	for _, c := range chains {
		resp = append(resp, ChainResponse{
			ChainID:   c.ChainID,
			Name:      c.Name,
			Symbol:    c.Symbol,
			IsTestnet: c.IsTestnet,
		})
	}

	writeJSON(w, http.StatusOK, ChainResponseEnvelope{Data: resp})
}
