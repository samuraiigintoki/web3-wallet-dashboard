package wallet

import (
	"database/sql"
	"errors"
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

func (repo *PostgresWalletRepo) Create(w Wallet) (Wallet, error) {
	query := `
		INSERT INTO wallets (address, chain_id, label)
		VALUES ($1,$2,$3)
		RETURNING id; 
	`

	err := repo.db.QueryRow(query, w.Address, w.ChainID, w.Label).Scan(&w.ID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Wallet{}, ErrWalletDuplicate
		}
		return Wallet{}, err
	}

	return w, nil
}

func (repo *PostgresWalletRepo) GetByID(id int64) (Wallet, error) {

	query := `
		SELECT id, address, chain_id, label FROM wallets WHERE id = $1;
	`

	var w Wallet
	err := repo.db.QueryRow(query, id).Scan(&w.ID, &w.Address, &w.ChainID, &w.Label)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Wallet{}, ErrWalletNotFound
		}
		return Wallet{}, err
	}

	return w, nil
}
