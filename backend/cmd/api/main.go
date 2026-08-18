package main

import (
	"log"
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
)

func main() {
	handler := httpapi.NewRouter()

	addr := ":8080"
	log.Printf("Starting HTTP Server on %s...", addr)

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("Server failed to start : %v", err)
	}
}
