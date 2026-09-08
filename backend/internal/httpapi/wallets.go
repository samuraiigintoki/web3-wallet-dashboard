package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

const maxBodyBytes = 1 << 20 //1 MB

// 1. Inbound DTO
type CreateWalletRequest struct {
	Address string `json:"address"`
	ChainID int64  `json:"chainId"`
	Label   string `json:"label"`
}

// 2. Outbound DTO
type WalletResponse struct {
	ID      int64  `json:"id"`
	Address string `json:"address"`
	ChainID int64  `json:"chainId"`
	Label   string `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
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

	createdWallet, err := h.walletSvc.Create(r.Context(), req.Address, req.ChainID, req.Label)
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
			ID:      createdWallet.ID,
			Address: createdWallet.Address,
			ChainID: createdWallet.ChainID,
			Label:   createdWallet.Label,
			CreatedAt: createdWallet.CreatedAt,
		},
	})
}

func (h *Handler) getWallet(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
		return
	}

	foundWallet, err := h.walletSvc.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, wallet.ErrWalletNotFound) {
			writeError(w, http.StatusNotFound, CodeResourceNotFound, "wallet not found", nil)
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	writeJSON(w, http.StatusOK, WalletResponseEnvelope{
		WalletResponse{
			ID:      foundWallet.ID,
			Address: foundWallet.Address,
			ChainID: foundWallet.ChainID,
			Label:   foundWallet.Label,
			CreatedAt: foundWallet.CreatedAt,
		},
	})
}
