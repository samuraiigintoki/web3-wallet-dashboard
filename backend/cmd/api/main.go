package main

import (
	"database/sql"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
	"log"
	"net/http"
	"os"
)

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatalf("DATABASE_URL environment variable is required")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatalf("failed to initiate DB pool : %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("DB unreachable : %v", err)
	}

	repo := wallet.NewPostgresWalletRepo(db)
	svc := wallet.NewService(repo)
	handler := httpapi.NewRouter(svc)

	addr := ":8080"
	log.Printf("Starting HTTP Server on %s...", addr)

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("Server failed to start : %v", err)
	}
}
