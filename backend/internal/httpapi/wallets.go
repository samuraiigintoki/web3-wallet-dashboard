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
	ID        int64     `json:"id"`
	Address   string    `json:"address"`
	ChainID   int64     `json:"chainId"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
}

// 3. Outbound Envelope
type WalletResponseEnvelope struct {
	Data WalletResponse `json:"data"`
}

// $. Pagination
type Pagination struct {
	Page       int   `json:"page"`
	PageSize   int   `json:"pageSize"`
	TotalItems int64 `json:"totalItems"`
	TotalPages int64 `json:"totalPages"`
}

// 6. List Envelope
type WalletListEnvelope struct {
	Data       []WalletResponse `json:"data"`
	Pagination Pagination       `json:"pagination"`
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
			ID:        createdWallet.ID,
			Address:   createdWallet.Address,
			ChainID:   createdWallet.ChainID,
			Label:     createdWallet.Label,
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
			ID:        foundWallet.ID,
			Address:   foundWallet.Address,
			ChainID:   foundWallet.ChainID,
			Label:     foundWallet.Label,
			CreatedAt: foundWallet.CreatedAt,
		},
	})
}

func (h *Handler) listWallets(w http.ResponseWriter, r *http.Request) {
	queryParams := r.URL.Query()

	pageStr := queryParams.Get("page")
	pageSizeStr := queryParams.Get("pageSize")
	chainIdStr := queryParams.Get("chainId")
	searchStr := queryParams.Get("search")

	var filter wallet.WalletFilter

	if pageStr != "" {
		page, err := strconv.ParseInt(pageStr, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
			return
		}
		filter.Page = int(page)
	}

	if pageSizeStr != "" {
		pageSize, err := strconv.ParseInt(pageSizeStr, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
			return
		}
		filter.PageSize = int(pageSize)
	}

	if chainIdStr != "" {
		chainID, err := strconv.ParseInt(chainIdStr, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
			return
		}
		filter.ChainID = chainID
	}

	if searchStr != "" {
		filter.Search = searchStr
	}

	wallets, totalItems, err := h.walletSvc.List(r.Context(), filter)

	if err != nil {
		var vErr *wallet.ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusBadRequest, CodeValidationError, vErr.Message, map[string]string{vErr.Field: vErr.Message})
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	walletResponses := make([]WalletResponse, 0, len(wallets))
	for _, ws := range wallets {
		walletResponses = append(walletResponses, WalletResponse{
			ID:        ws.ID,
			Address:   ws.Address,
			ChainID:   ws.ChainID,
			Label:     ws.Label,
			CreatedAt: ws.CreatedAt,
		})
	}

	effectivePage := 1
	if filter.Page != 0 {
		effectivePage = filter.Page
	}

	effectivePageSize := 20
	if filter.PageSize != 0 {
		effectivePageSize = filter.PageSize
	}

	var totalPages int64
	if totalItems > 0 {
		totalPages = (totalItems + int64(effectivePageSize) - 1) / int64(effectivePageSize)
	}

	responsePayload := WalletListEnvelope{
		Data: walletResponses,
		Pagination: Pagination{
			Page:       effectivePage,
			PageSize:   effectivePageSize,
			TotalItems: totalItems,
			TotalPages: totalPages,
		},
	}

	writeJSON(w, http.StatusOK, responsePayload)
}
