package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
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

func run(ctx context.Context, logger *slog.Logger) (runErr error) {
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
			logger.Error("failed to close DB pool", "error", err)
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

	globalLimiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	authLimiter := newTokenBucketLimiter(authLimitPerMinute, authLimitBurst)
	handler := httpapi.NewRouter(walletSvc, userSvc, chainSvc, contractSvc, logger, databaseReadiness{db: db}, globalLimiter, authLimiter)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	logger.Info("HTTP server bound", "address", ln.Addr().String())

	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}

	serveErr := serve(ctx, ln, srv, shutdownGracePeriod, logger)
	// B5 stops its worker here, after the HTTP drain and before the deferred DB close.
	return serveErr
}

func serve(ctx context.Context, ln net.Listener, srv *http.Server, grace time.Duration, logger *slog.Logger) error {
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
		logger.Info("shutdown started", "grace", grace)

		shutdownCtx, cancel := context.WithTimeout(context.Background(), grace)
		defer cancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			closeErr := srv.Close()
			logger.Error("shutdown forced close", "elapsed", time.Since(started), "error", err)
			if closeErr != nil {
				logger.Error("server close returned error", "error", closeErr)
			}
			return fmt.Errorf("HTTP server shutdown failed: %w; grace deadline: %w", err, context.DeadlineExceeded)
		}

		if err := <-serveErr; err != http.ErrServerClosed {
			if err == nil {
				return errors.New("HTTP server stopped without http.ErrServerClosed after shutdown")
			}
			return fmt.Errorf("HTTP server returned unexpectedly after shutdown: %w", err)
		}

		logger.Info("shutdown complete", "elapsed", time.Since(started))
		return nil
	}
}
