package httpapi

import (
	"net/http"
)

type healthResponse struct {
	Status string `json:"status"`
}

func healthHandler(w http.ResponseWriter, r *http.Request) {

	writeJSON(w, http.StatusOK, healthResponse{Status: "ok"})

}
