package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxBodyBytes = 1 << 20

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

func createWalletHandler(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	var req CreateWalletRequest
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "invalid request body", nil)
		return
	}

	if err := validateAddress(req.Address); err != nil {
		var vErr *ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusUnprocessableEntity, CodeValidationError, vErr.Message, map[string]string{
				vErr.Field: vErr.Message})
			return
		}
	}

	if err := validateChainID(req.ChainID); err != nil {
		var vErr *ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusUnprocessableEntity, CodeValidationError, vErr.Message, map[string]string{
				vErr.Field: vErr.Message})
			return
		}
	}

	if err := validateLabel(req.Label); err != nil {
		var vErr *ValidationError
		if errors.As(err, &vErr) {
			writeError(w, http.StatusUnprocessableEntity, CodeValidationError, vErr.Message, map[string]string{
				vErr.Field: vErr.Message})
			return
		}
	}

	envelope := WalletResponseEnvelope{
		Data: WalletResponse{
			Address: strings.TrimSpace(req.Address),
			ChainID: req.ChainID,
			Label:   strings.TrimSpace(req.Label),
		},
	}
	writeJSON(w, http.StatusCreated, envelope)

}

func validateAddress(addr string) error {

	trimmed := strings.TrimSpace(addr)

	if len(trimmed) == 0 {
		return &ValidationError{Field: "address", Message: "address is required"}
	}

	if !strings.HasPrefix(trimmed, "0x") {
		return &ValidationError{Field: "address", Message: "address must start with 0x"}
	}

	if len(trimmed) != 42 {
		return &ValidationError{Field: "address", Message: "address must be of length 42"}
	}

	return nil
}

func validateLabel(label string) error {

	trimmed := strings.TrimSpace(label)

	if len(trimmed) == 0 {
		return &ValidationError{Field: "label", Message: "label is required"}
	}

	if utf8.RuneCountInString(trimmed) > 50 {
		return &ValidationError{Field: "label", Message: "label must be less than 50 characters"}
	}

	return nil
}

func validateChainID(chainID int) error {
	if chainID <= 0 {
		return &ValidationError{Field: "chainId", Message: "chainId must be a positive integer"}
	}
	return nil
}
