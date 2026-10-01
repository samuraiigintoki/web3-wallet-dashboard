package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/contract"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/httpapi"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const (
	defaultAddr         = ":8080"
	databasePingTimeout = 5 * time.Second
	shutdownGracePeriod = 10 * time.Second
	readHeaderTimeout   = 5 * time.Second
	readTimeout         = 10 * time.Second
	writeTimeout        = 15 * time.Second
	idleTimeout         = 60 * time.Second
	maxHeaderBytes      = 1 << 20
)

func run(ctx context.Context) (runErr error) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL environment variable is required")
	}

	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = defaultAddr
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return fmt.Errorf("failed to initiate DB pool: %w", err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			log.Printf("failed to close DB pool: %v", err)
			if runErr == nil {
				runErr = fmt.Errorf("failed to close DB pool: %w", err)
			}
		}
	}()

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(25)
	db.SetConnMaxLifetime(5 * time.Minute)

	pingCtx, cancelPing := context.WithTimeout(ctx, databasePingTimeout)
	err = db.PingContext(pingCtx)
	cancelPing()
	if err != nil {
		return fmt.Errorf("DB unreachable: %w", err)
	}

	chainRepo := chain.NewPostgresRepository(db)
	chainSvc := chain.NewService(chainRepo)

	walletRepo := wallet.NewPostgresWalletRepo(db)
	walletSvc := wallet.NewService(walletRepo, chainSvc)

	userRepo := user.NewPostgresUserRepository(db)
	userSvc := user.NewService(userRepo)

	contractRepo := contract.NewPostgresRepository(db)
	contractSvc := contract.NewService(contractRepo, chainSvc)

	handler := httpapi.NewRouter(walletSvc, userSvc, chainSvc, contractSvc)
	// B3 readiness is wired into the router before the listener is opened.

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	log.Printf("HTTP server bound to %s", ln.Addr())

	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}

	serveErr := serve(ctx, ln, srv, shutdownGracePeriod)
	// B5 stops its worker here, after the HTTP drain and before the deferred DB close.
	return serveErr
}

func serve(ctx context.Context, ln net.Listener, srv *http.Server, grace time.Duration) error {
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.Serve(ln)
	}()

	select {
	case err := <-serveErr:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-ctx.Done():
		started := time.Now()
		log.Printf("shutdown started, grace=%s", grace)

		shutdownCtx, cancel := context.WithTimeout(context.Background(), grace)
		defer cancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			closeErr := srv.Close()
			log.Printf("shutdown forced close, elapsed=%s, error=%v", time.Since(started), err)
			if closeErr != nil {
				log.Printf("server close returned error: %v", closeErr)
			}
			return fmt.Errorf("HTTP server shutdown failed: %w; grace deadline: %w", err, context.DeadlineExceeded)
		}

		if err := <-serveErr; err != http.ErrServerClosed {
			if err == nil {
				return errors.New("HTTP server stopped without http.ErrServerClosed after shutdown")
			}
			return fmt.Errorf("HTTP server returned unexpectedly after shutdown: %w", err)
		}

		log.Printf("shutdown complete, elapsed=%s", time.Since(started))
		return nil
	}
}
