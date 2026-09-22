package chain_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/chain"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestParity_ListEnabled(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	ctx := context.Background()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}

	// Insert disabled throwaway chain
	const throwawayID = 9999997
	_, err = db.ExecContext(ctx,
		`INSERT INTO chains (chain_id, name, symbol, is_testnet, enabled)
		 VALUES ($1, 'Throwaway', 'TH', false, false)
		 ON CONFLICT DO NOTHING`, throwawayID)
	if err != nil {
		t.Fatalf("insert throwaway: %v", err)
	}
	t.Cleanup(func() {
		db.ExecContext(context.Background(), `DELETE FROM chains WHERE chain_id = $1`, throwawayID)
	})

	pgRepo := chain.NewPostgresRepository(db)
	pgList, err := pgRepo.ListEnabled(ctx)
	if err != nil {
		t.Fatalf("pg ListEnabled: %v", err)
	}

	// Seed inmemory with exact pg rows + the disabled throwaway
	memRepo := chain.NewInMemoryRepository()
	memRepo.Seed(pgList...)
	memRepo.Seed(chain.Chain{ChainID: throwawayID, Name: "Throwaway", Symbol: "TH", Enabled: false})

	memList, err := memRepo.ListEnabled(ctx)
	if err != nil {
		t.Fatalf("mem ListEnabled: %v", err)
	}

	if !reflect.DeepEqual(pgList, memList) {
		t.Fatalf("parity mismatch:\npg:  %+v\nmem: %+v", pgList, memList)
	}
}

func TestParity_GetByID(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	ctx := context.Background()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}

	const throwawayID = 9999997
	_, err = db.ExecContext(ctx,
		`INSERT INTO chains (chain_id, name, symbol, is_testnet, enabled)
		 VALUES ($1, 'Throwaway', 'TH', false, false)
		 ON CONFLICT DO NOTHING`, throwawayID)
	if err != nil {
		t.Fatalf("insert throwaway: %v", err)
	}
	t.Cleanup(func() {
		db.ExecContext(context.Background(), `DELETE FROM chains WHERE chain_id = $1`, throwawayID)
	})

	pgRepo := chain.NewPostgresRepository(db)
	memRepo := chain.NewInMemoryRepository()
	memRepo.Seed(chain.Chain{ChainID: throwawayID, Name: "Throwaway", Symbol: "TH", Enabled: false})

	// Disabled chain: found with Enabled=false on both
	pgChain, pgErr := pgRepo.GetByID(ctx, throwawayID)
	memChain, memErr := memRepo.GetByID(ctx, throwawayID)
	if pgErr != nil || memErr != nil {
		t.Fatalf("GetByID disabled: pg=%v mem=%v", pgErr, memErr)
	}
	if pgChain.Enabled || memChain.Enabled {
		t.Fatal("expected Enabled=false on both sides")
	}

	// Never-seeded chain: ErrNotFound on both
	const missingID = 8888888
	_, pgErr = pgRepo.GetByID(ctx, missingID)
	_, memErr = memRepo.GetByID(ctx, missingID)
	if !errors.Is(pgErr, chain.ErrNotFound) {
		t.Fatalf("pg expected ErrNotFound, got %v", pgErr)
	}
	if !errors.Is(memErr, chain.ErrNotFound) {
		t.Fatalf("mem expected ErrNotFound, got %v", memErr)
	}
}
