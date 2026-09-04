package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

const maxBodyBytes = 1 << 20 //1 MB

// 1. Inbound DTO
type CreateWalletRequest struct {
	Address string `json:"address"`
	ChainID int    `json:"chainId"`
	Label   string `json:"label"`
}

// 2. Outbound DTO
type WalletResponse struct {
	Address string `json:"address"`
	ChainID int    `json:"chainId"`
	Label   string `json:"label"`
}

// 3. Outbound Envelope
type WalletResponseEnvelope struct {
	Data WalletResponse `json:"data"`
}

// Handler struct
type Handler struct {
	walletSvc *wallet.Service
}

// Handler constructor
func NewHandler(walletSvc *wallet.Service) *Handler {
	return &Handler{
		walletSvc: walletSvc,
	}
}

// Handler
func (h *Handler) createWallet(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	var req CreateWalletRequest
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "invalid request body", nil)
		return
	}

	createdWallet, err := h.walletSvc.Create(req.Address, req.ChainID, req.Label)
	if err != nil {
		var vErr *wallet.ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusUnprocessableEntity, CodeValidationError, vErr.Message, map[string]string{vErr.Field: vErr.Message})
			return
		}

		if errors.Is(err, wallet.ErrWalletDuplicate) {
			writeError(w, http.StatusConflict, CodeResourceConflict, err.Error(), nil)
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	writeJSON(w, http.StatusCreated, WalletResponseEnvelope{
		Data: WalletResponse{
			Address: createdWallet.Address,
			ChainID: createdWallet.ChainID,
			Label:   createdWallet.Label,
		},
	})


	
}
