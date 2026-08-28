package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxBodyBytes = 1 << 20

type CreateWalletRequest struct {
	Address string `json:"address"`
	ChainID int    `json:"chainId"`
	Label   string `json:"label"`
}

type WalletResponseEnvolope struct {
	Data CreateWalletRequest `json:"data"`
}

func createWalletHandler(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	var req CreateWalletRequest
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid request body")
		return
	}

	if err := validateAddress(req.Address); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
		return
	}

	if req.ChainID <= 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "chainId must be a positive integer")
		return
	}

	if err := validateLabel(req.Label); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
		return
	}

	envelope := WalletResponseEnvolope{
		Data: CreateWalletRequest{
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
		return errors.New("address required!!")
	}

	if !strings.HasPrefix(trimmed, "0x") {
		return errors.New("invalid address type")
	}

	if len(trimmed) != 42 {
		return errors.New("address must be of length 42")
	}

	return nil
}

func validateLabel(label string) error {

	trimmed := strings.TrimSpace(label)

	if len(trimmed) == 0 {
		return errors.New("label required!!")
	}

	if utf8.RuneCountInString(trimmed) > 50 {
		return errors.New("label must be less than 50 characters")
	}

	return nil
}
