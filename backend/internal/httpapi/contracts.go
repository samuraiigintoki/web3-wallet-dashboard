package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
)

// 1. Inbound DTO
type CreateContractRequest struct {
	Address    string `json:"address"`
	ChainID    int64  `json:"chainId"`
	Label      string `json:"label"`
	StartBlock int64  `json:"startBlock"`
}

// 2. PATCH handler DTO (pointers: absent field means "leave unchanged")
type UpdateContractRequest struct {
	Label   *string `json:"label"`
	Enabled *bool   `json:"enabled"`
}

// 3. Outbound DTO (hand-mapped from TrackedContract, no domain serialization)
type ContractResponse struct {
	ID         int64     `json:"id"`
	Address    string    `json:"address"`
	ChainID    int64     `json:"chainId"`
	Label      string    `json:"label"`
	Enabled    bool      `json:"enabled"`
	StartBlock int64     `json:"startBlock"`
	CreatedAt  time.Time `json:"createdAt"`
}

// 4. Outbound Envelopes
type ContractResponseEnvelope struct {
	Data ContractResponse `json:"data"`
}

type ContractListEnvelope struct {
	Data       []ContractResponse `json:"data"`
	Pagination Pagination         `json:"pagination"`
}

// 5. Handler functions
func (h *Handler) createContract(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}

	var req CreateContractRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "invalid request body", nil)
		return
	}

	createdContract, err := h.contractSvc.Create(r.Context(), u.ID, contract.CreateInput{
		Address:    req.Address,
		ChainID:    req.ChainID,
		Label:      req.Label,
		StartBlock: req.StartBlock,
	})
	if err != nil {
		var vErr *contract.ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusUnprocessableEntity, CodeValidationError, vErr.Message, map[string]string{vErr.Field: vErr.Message})
			return
		}

		if errors.Is(err, contract.ErrAlreadyTracked) {
			writeError(w, http.StatusConflict, CodeResourceConflict, err.Error(), nil)
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	writeJSON(w, http.StatusCreated, ContractResponseEnvelope{Data: contractToResponse(createdContract)})
}

func (h *Handler) listContracts(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}

	queryParams := r.URL.Query()

	var filter contract.ListFilter

	pageStr := queryParams.Get("page")
	pageSizeStr := queryParams.Get("pageSize")
	chainIdStr := queryParams.Get("chainId")
	searchStr := queryParams.Get("search")

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

	// enabled is a strict literal parse. Has separates "absent" from "empty":
	// Get returns "" for both, and an empty value is a client error, not "no filter".
	if queryParams.Has("enabled") {
		switch queryParams.Get("enabled") {
		case "true":
			filter.Enabled = boolPtr(true)
		case "false":
			filter.Enabled = boolPtr(false)
		default:
			writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
			return
		}
	}

	contracts, totalItems, err := h.contractSvc.List(r.Context(), u.ID, filter)
	if err != nil {
		var vErr *contract.ValidationError
		if errors.As(err, &vErr) {
			status := http.StatusBadRequest
			if vErr.Field == "chainId" {
				status = http.StatusUnprocessableEntity
			}
			writeError(w, status, CodeValidationError, vErr.Message, map[string]string{vErr.Field: vErr.Message})
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	contractResponses := make([]ContractResponse, 0, len(contracts))
	for i := range contracts {
		contractResponses = append(contractResponses, contractToResponse(&contracts[i]))
	}

	effectivePage := 1
	if filter.Page > 0 {
		effectivePage = filter.Page
	}

	effectivePageSize := 20
	if filter.PageSize > 0 {
		effectivePageSize = filter.PageSize
	}

	var totalPages int64
	if totalItems > 0 {
		totalPages = (int64(totalItems) + int64(effectivePageSize) - 1) / int64(effectivePageSize)
	}

	responsePayload := ContractListEnvelope{
		Data: contractResponses,
		Pagination: Pagination{
			Page:       effectivePage,
			PageSize:   effectivePageSize,
			TotalItems: int64(totalItems),
			TotalPages: totalPages,
		},
	}

	writeJSON(w, http.StatusOK, responsePayload)
}

func (h *Handler) getContract(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}

	idStr := r.PathValue("id")

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
		return
	}

	foundContract, err := h.contractSvc.Get(r.Context(), u.ID, id)
	if err != nil {
		if errors.Is(err, contract.ErrContractNotFound) {
			writeError(w, http.StatusNotFound, CodeResourceNotFound, contract.ErrContractNotFound.Error(), nil)
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	writeJSON(w, http.StatusOK, ContractResponseEnvelope{Data: contractToResponse(foundContract)})
}

func (h *Handler) updateContract(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}

	idStr := r.PathValue("id")

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
		return
	}

	// Body decode comes after id parsing, so a malformed body returns 400 for
	// both real and fake ids — no existence oracle.
	var req UpdateContractRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "invalid request body", nil)
		return
	}

	updatedContract, err := h.contractSvc.Update(r.Context(), u.ID, id, req.Label, req.Enabled)
	if err != nil {
		var vErr *contract.ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusUnprocessableEntity, CodeValidationError, vErr.Message, map[string]string{vErr.Field: vErr.Message})
			return
		}

		if errors.Is(err, contract.ErrContractNotFound) {
			writeError(w, http.StatusNotFound, CodeResourceNotFound, contract.ErrContractNotFound.Error(), nil)
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	writeJSON(w, http.StatusOK, ContractResponseEnvelope{Data: contractToResponse(updatedContract)})
}

func (h *Handler) deleteContract(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}

	idStr := r.PathValue("id")

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, CodeValidationError, "invalid request", nil)
		return
	}

	err = h.contractSvc.Delete(r.Context(), u.ID, id)
	if err != nil {
		if errors.Is(err, contract.ErrContractNotFound) {
			writeError(w, http.StatusNotFound, CodeResourceNotFound, contract.ErrContractNotFound.Error(), nil)
			return
		}

		writeError(w, http.StatusInternalServerError, CodeInternalError, "internal server error", nil)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

///// Helper functions

// contractToResponse hand-maps the domain record onto the wire DTO.
func contractToResponse(tc *contract.TrackedContract) ContractResponse {
	return ContractResponse{
		ID:         tc.ID,
		Address:    tc.Address,
		ChainID:    tc.ChainID,
		Label:      tc.Label,
		Enabled:    tc.Enabled,
		StartBlock: tc.StartBlock,
		CreatedAt:  tc.CreatedAt,
	}
}

// currentUser returns the authenticated user attached by RequireAuth. Every
// contract route is mounted behind that middleware, so a missing user means the
// route was registered without it — a wiring bug, not a client state. Hence 500
// rather than 401: there is no client input that can produce this. Note that
// getCurrentUser in auth.go answers 401 for the same impossible case; unify later.
func (h *Handler) currentUser(w http.ResponseWriter, r *http.Request) (user.User, bool) {
	u, ok := UserFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, CodeUnauthenticated, "unauthenticated", nil)
		return user.User{}, false
	}
	return u, true
}

func boolPtr(b bool) *bool {
	return &b
}
