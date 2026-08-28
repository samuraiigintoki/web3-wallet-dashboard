package httpapi

import (
	"encoding/json"
	"net/http"
)

type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ErrorEnvolope struct {
	Error ErrorDetail `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, data any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {

	resp := ErrorEnvolope{
		Error: ErrorDetail{
			Code:    code,
			Message: message,
		},
	}

	writeJSON(w, status, resp)
}
