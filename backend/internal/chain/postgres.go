package chain

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type PostgresRepository struct {
	db *sql.DB
}

func NewPostgresRepository(db *sql.DB) *PostgresRepository {
	return &PostgresRepository{
		db: db,
	}
}

func (repo *PostgresRepository) ListEnabled(ctx context.Context) ([]Chain, error) {
	const query = `
		SELECT chain_id, name, symbol, is_testnet, enabled, created_at
		FROM chains
		WHERE enabled = TRUE
		ORDER BY chain_id
	`
	rows, err := repo.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("list enabled chains: %w", err)
	}
	defer rows.Close()

	var chains []Chain
	for rows.Next() {
		var c Chain
		if err := rows.Scan(
			&c.ChainID,
			&c.Name,
			&c.Symbol,
			&c.IsTestnet,
			&c.Enabled,
			&c.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan chain: %w", err)
		}
		chains = append(chains, c)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chains: %w", err)
	}

	return chains, nil
}

func (repo *PostgresRepository) GetByID(ctx context.Context, id int64) (*Chain, error) {

	const query = `
		SELECT chain_id, name, symbol, is_testnet, enabled, created_at
		FROM chains
		WHERE chain_id = $1
	`

	var c Chain
	err := repo.db.QueryRowContext(ctx, query, id).Scan(
		&c.ChainID,
		&c.Name,
		&c.Symbol,
		&c.IsTestnet,
		&c.Enabled,
		&c.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get chain by id: %w", err)
	}

	return &c, nil
}
