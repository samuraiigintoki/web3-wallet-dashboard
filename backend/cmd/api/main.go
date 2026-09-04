package main

import (
	"log"
	"net/http"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func main() {
	repo := wallet.NewInMemoryWalletRepo()
	svc := wallet.NewService(repo)
	handler := httpapi.NewRouter(svc)

	addr := ":8080"
	log.Printf("Starting HTTP Server on %s...", addr)

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("Server failed to start : %v", err)
	}
}
