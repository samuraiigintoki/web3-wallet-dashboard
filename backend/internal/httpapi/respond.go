package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
)

type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ErrorEnvelope struct {
	Error ErrorDetail `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, data any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {

	resp := ErrorEnvelope{
		Error: ErrorDetail{
			Code:    code,
			Message: message,
		},
	}

	if err := writeJSON(w, status, resp); err != nil {
    log.Printf("failed to write error response: %v", err)
	}
}
