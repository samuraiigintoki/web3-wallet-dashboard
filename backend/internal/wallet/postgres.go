package wallet

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

type PostgresWalletRepo struct {
	db *sql.DB
}

func NewPostgresWalletRepo(db *sql.DB) *PostgresWalletRepo {
	return &PostgresWalletRepo{
		db: db,
	}
}

func (repo *PostgresWalletRepo) Create(ctx context.Context, w Wallet) (Wallet, error) {
	query := `
		INSERT INTO wallets (address, chain_id, label)
		VALUES ($1,$2,$3)
		RETURNING id, created_at; 
	`

	err := repo.db.QueryRowContext(ctx, query, w.Address, w.ChainID, w.Label).Scan(&w.ID, &w.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "unique_address_chain" {
			return Wallet{}, ErrWalletDuplicate
		}
		return Wallet{}, err
	}

	return w, nil
}

func (repo *PostgresWalletRepo) GetByID(ctx context.Context, id int64) (Wallet, error) {

	query := `
		SELECT id, address, chain_id, label, created_at FROM wallets WHERE id = $1;
	`

	var w Wallet
	err := repo.db.QueryRowContext(ctx, query, id).Scan(&w.ID, &w.Address, &w.ChainID, &w.Label, &w.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Wallet{}, ErrWalletNotFound
		}
		return Wallet{}, err
	}

	return w, nil
}


func (repo *PostgresWalletRepo) List(ctx context.Context, filter WalletFilter) ([]Wallet, int64, error) {
	whereClauses := []string{"1=1"}
	args := []any{}
	argIndex := 1		

	if filter.ChainID > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("chain_id = $%d", argIndex))
		args = append(args, filter.ChainID)
		argIndex++
	}

	if filter.Search != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("(STRPOS(LOWER(label), LOWER($%d)) > 0 OR STRPOS(LOWER(address), LOWER($%d)) > 0)", argIndex, argIndex))
		args = append(args, filter.Search)
		argIndex++
	}

	whereSQL := strings.Join(whereClauses, " AND ")

	countQuery := "SELECT COUNT(*) FROM wallets WHERE " + whereSQL
	var totalItems int64
	err := repo.db.QueryRowContext(ctx, countQuery, args...).Scan(&totalItems)
	if err != nil {
		return nil, 0, err
	}

	offset := (filter.Page - 1) * filter.PageSize

	if offset < 0 || offset >= int(totalItems) || filter.PageSize <= 0 {
		return make([]Wallet, 0), totalItems, nil
	}

	selectQuery := fmt.Sprintf(
		"SELECT id, address, chain_id, label, created_at FROM wallets WHERE %s ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d",
		whereSQL, argIndex, argIndex+1,
	)

	selectArgs := append(args, filter.PageSize, offset)

	rows, err := repo.db.QueryContext(ctx, selectQuery, selectArgs...)
	if err != nil {
		return nil, 0, err
	}	
	defer rows.Close()

	wallets := make([]Wallet, 0)

	for rows.Next() {
		var w Wallet
		err := rows.Scan(&w.ID, &w.Address, &w.ChainID, &w.Label, &w.CreatedAt)
		if err != nil {
			return nil, 0, err
		}
		wallets = append(wallets, w)
	}

	if err = rows.Err(); err != nil {
		return nil, 0, err
	}

	return wallets, totalItems, nil 
}
