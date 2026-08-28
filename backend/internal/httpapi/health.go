package httpapi

import (
	"log"
	"net/http"
)

type healthResponse struct {
	Status string `json:"status"`
}

func healthHandler(w http.ResponseWriter, r *http.Request) {

	if err := writeJSON(w, http.StatusOK, healthResponse{Status: "ok"}); err != nil {
		log.Printf("failed to write health response: %v", err)
	}

}
