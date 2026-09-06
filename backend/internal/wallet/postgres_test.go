package wallet_test

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/wallet"
)

func TestPostgresWalletRepo_Integration(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("skipping integration test:DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("error initializing database: %v", err)
	}

	if err := db.Ping(); err != nil {
		t.Fatalf("error connecting dabatase:%v", err)
	}

	repo := wallet.NewPostgresWalletRepo(db)

	uniqueAddr := fmt.Sprintf("0x%040x", time.Now().UnixNano())
	createWallet := wallet.Wallet{
		Address: uniqueAddr,
		ChainID: 1,
		Label:   "Test",
	}
	created, err := repo.Create(createWallet)
	if err != nil {
		t.Fatalf("error during creation :%v", err)
	}
	if created.ID <= 0 {
		t.Fatalf("expected valid generated database ID (> 0), got %d", created.ID)
	}

	_, err = repo.Create(createWallet)
	if err == nil {
		t.Error("expected error on inserting duplicate, got nil")
	}
	if !errors.Is(err, wallet.ErrWalletDuplicate) {
		t.Errorf("exprected: %v, got: %v", wallet.ErrWalletDuplicate, err)
	}

	fetched, err := repo.GetByID(created.ID)
	if err != nil {
		t.Fatalf("expected no errors, got: %v", err)
	}
	if fetched.Address != created.Address {
		t.Errorf("expected address %s, got %s", created.Address, fetched.Address)
	}

	_, err = repo.GetByID(99999999)
	if err == nil {
		t.Error("expected error for non-existent id, got nil")
	}
	if !errors.Is(err, wallet.ErrWalletNotFound) {
		t.Errorf("expected errors.Is(err,wallet.ErrWalletNotFound) to be true, got error: %v", err)
	}

}
