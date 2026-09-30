package wallet_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
	"os"
	"testing"
	"time"
)

func TestPostgresWalletRepo_Integration(t *testing.T) {
	ctx := t.Context()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("skipping integration test:DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("error initializing database: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
	})

	if err := db.Ping(); err != nil {
		t.Fatalf("error connecting database:%v", err)
	}

	repo := wallet.NewPostgresWalletRepo(db)

	userID := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "Test",
	}
	created, err := repo.Create(ctx, userID, createWallet)
	if err != nil {
		t.Fatalf("error during creation :%v", err)
	}
	if created.ID <= 0 {
		t.Fatalf("expected valid generated database ID (> 0), got %d", created.ID)
	}

	_, err = repo.Create(ctx, userID, createWallet)
	if err == nil {
		t.Error("expected error on inserting duplicate, got nil")
	}
	if !errors.Is(err, wallet.ErrWalletDuplicate) {
		t.Errorf("expected: %v, got: %v", wallet.ErrWalletDuplicate, err)
	}

	fetched, err := repo.GetByID(ctx, userID, created.ID)
	if err != nil {
		t.Fatalf("expected no errors, got: %v", err)
	}
	if fetched.Address != created.Address {
		t.Errorf("expected address %s, got %s", created.Address, fetched.Address)
	}

	_, err = repo.GetByID(ctx, userID, 99999999)
	if err == nil {
		t.Error("expected error for non-existent id, got nil")
	}
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("expected errors.Is(err,wallet.ErrWalletNotFound) to be true, got error: %v", err)
	}

}

func TestWalletRepository_CancelledContext(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("skipping integration test:DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("error initializing database: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
	})

	if err := db.Ping(); err != nil {
		t.Fatalf("error connecting database:%v", err)
	}

	repo := wallet.NewPostgresWalletRepo(db)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err = repo.GetByID(ctx, 1, 1)

	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got: %v", err)
	}

}

func TestPostgresUpdateLabel(t *testing.T) {
	ctx := t.Context()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("skipping integration test:DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("error initializing database: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
	})

	if err := db.Ping(); err != nil {
		t.Fatalf("error connecting database:%v", err)
	}

	repo := wallet.NewPostgresWalletRepo(db)

	userID := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "pg original label",
	}
	created, err := repo.Create(ctx, userID, createWallet)
	if err != nil {
		t.Fatalf("error during creation: %v", err)
	}

	updated, err := repo.Update(ctx, userID, created.ID, "pg new label")
	if err != nil {
		t.Fatalf("error during update: %v", err)
	}
	if updated.Label != "pg new label" {
		t.Errorf("expected label %q, got %q", "pg new label", updated.Label)
	}
	if !updated.CreatedAt.Equal(created.CreatedAt) {
		t.Errorf("expected createdAt %v, got %v", created.CreatedAt, updated.CreatedAt)
	}

	fetched, err := repo.GetByID(ctx, userID, created.ID)
	if err != nil {
		t.Fatalf("expected no error fetching after update, got: %v", err)
	}
	if fetched.Label != "pg new label" {
		t.Errorf("expected persisted label %q, got %q", "pg new label", fetched.Label)
	}
}

func TestPostgresDelete(t *testing.T) {
	ctx := t.Context()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("skipping integration test:DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("error initializing database: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
	})

	if err := db.Ping(); err != nil {
		t.Fatalf("error connecting database:%v", err)
	}

	repo := wallet.NewPostgresWalletRepo(db)

	userID := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "pg delete me",
	}
	created, err := repo.Create(ctx, userID, createWallet)
	if err != nil {
		t.Fatalf("error during creation: %v", err)
	}

	if err := repo.Delete(ctx, userID, created.ID); err != nil {
		t.Fatalf("expected no error deleting, got: %v", err)
	}

	_, err = repo.GetByID(ctx, userID, created.ID)
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("expected errors.Is(err, wallet.ErrWalletNotFound) to be true, got: %v", err)
	}
}

func TestPostgresDeleteNotFound(t *testing.T) {
	ctx := t.Context()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("skipping integration test:DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("error initializing database: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
	})

	if err := db.Ping(); err != nil {
		t.Fatalf("error connecting database:%v", err)
	}

	repo := wallet.NewPostgresWalletRepo(db)

	userID := seedWalletTestUser(t, db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())

	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM wallets WHERE address = $1", uniqueAddr)
	})

	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "pg second delete",
	}
	created, err := repo.Create(ctx, userID, createWallet)
	if err != nil {
		t.Fatalf("error during creation: %v", err)
	}

	if err := repo.Delete(ctx, userID, created.ID); err != nil {
		t.Fatalf("expected no error on first delete, got: %v", err)
	}

	err = repo.Delete(ctx, userID, created.ID)
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("expected errors.Is(err, wallet.ErrWalletNotFound) on second delete, got: %v", err)
	}
}

// seedWalletTestUser inserts a throwaway user row: migration 0006 makes
// wallets.user_id a NOT NULL foreign key into users, so owner-scoped wallet
// rows need a real owner. Mirrors contract/postgres_test.go's user fixture.
func seedWalletTestUser(t *testing.T, db *sql.DB) int64 {
	t.Helper()

	email := fmt.Sprintf("wallet-pg-%d@example.com", time.Now().UnixNano())
	var userID int64
	err := db.QueryRowContext(t.Context(), `
		INSERT INTO users (email, password_hash)
		VALUES ($1, $2)
		RETURNING id
	`, email, "not-used-by-wallet-tests").Scan(&userID)
	if err != nil {
		t.Fatalf("seed test user: %v", err)
	}

	t.Cleanup(func() {
		if _, err := db.ExecContext(context.Background(), "DELETE FROM users WHERE id = $1", userID); err != nil {
			t.Errorf("clean up test user %d: %v", userID, err)
		}
	})
	return userID
}
