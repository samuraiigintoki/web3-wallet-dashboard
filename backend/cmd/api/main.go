package main

import (
	"database/sql"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
	"log"
	"net/http"
	"os"
	"context"
	"time"
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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		log.Fatalf("DB unreachable : %v", err)
	}

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(25)
	db.SetConnMaxLifetime(5*time.Minute)

	repo := wallet.NewPostgresWalletRepo(db)
	svc := wallet.NewService(repo)
	handler := httpapi.NewRouter(svc)

	addr := ":8080"
	log.Printf("Starting HTTP Server on %s...", addr)

	srv := &http.Server{
    	Addr:              addr,
    	Handler:           handler,
    	ReadHeaderTimeout: 5 * time.Second, // to mitigate Slowloris Dos attack
    	IdleTimeout:       60 * time.Second, 
	}

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("Server failed to start : %v", err)
	}
}
