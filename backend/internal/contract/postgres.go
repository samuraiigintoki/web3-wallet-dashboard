package contract

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

var _ Repository = (*PostgresRepository)(nil)

type PostgresRepository struct {
	db *sql.DB
}

func NewPostgresRepository(db *sql.DB) *PostgresRepository {
	return &PostgresRepository{db: db}
}

func (r *PostgresRepository) GetOrCreateDeployment(ctx context.Context, chainID int64, address string, startBlock int64) (*Contract, error) {
	address = strings.ToLower(strings.TrimSpace(address))

	const insertQuery = `
		INSERT INTO contracts (chain_id, address, start_block, indexing_enabled, created_at, updated_at)
		VALUES ($1, $2, $3, true, NOW(), NOW())
		ON CONFLICT (chain_id, address) DO NOTHING
		RETURNING id, chain_id, address, start_block, indexing_enabled, created_at
	`

	var c Contract
	err := r.db.QueryRowContext(ctx, insertQuery, chainID, address, startBlock).Scan(
		&c.ID, &c.ChainID, &c.Address, &c.StartBlock, &c.IndexingEnabled, &c.CreatedAt,
	)
	if err == nil {
		return &c, nil
	}

	if errors.Is(err, sql.ErrNoRows) {
		const selectQuery = `
			SELECT id, chain_id, address, start_block, indexing_enabled, created_at
			FROM contracts
			WHERE chain_id = $1 AND address = $2
		`
		err = r.db.QueryRowContext(ctx, selectQuery, chainID, address).Scan(
			&c.ID, &c.ChainID, &c.Address, &c.StartBlock, &c.IndexingEnabled, &c.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		return &c, nil
	}

	return nil, err
}

func (r *PostgresRepository) InsertTracking(ctx context.Context, userID int64, contractID int64, label string, enabled bool) error {
	const query = `
		INSERT INTO user_contracts (user_id, contract_id, label, enabled, created_at, updated_at)
		VALUES ($1, $2, $3, $4, NOW(), NOW())
	`
	_, err := r.db.ExecContext(ctx, query, userID, contractID, label, enabled)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			if pgErr.Code == "23505" && pgErr.ConstraintName == "pk_user_contracts" {
				return ErrAlreadyTracked
			}
		}
		return err
	}
	return nil
}

func (r *PostgresRepository) GetTracking(ctx context.Context, userID int64, contractID int64) (*TrackedContract, error) {
	const query = `
		SELECT c.id, c.address, c.chain_id, c.start_block, uc.label, uc.enabled, uc.created_at
		FROM user_contracts uc
		JOIN contracts c ON uc.contract_id = c.id
		WHERE uc.user_id = $1 AND uc.contract_id = $2
	`
	var tc TrackedContract
	err := r.db.QueryRowContext(ctx, query, userID, contractID).Scan(
		&tc.ID, &tc.Address, &tc.ChainID, &tc.StartBlock, &tc.Label, &tc.Enabled, &tc.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrContractNotFound
	}
	if err != nil {
		return nil, err
	}
	return &tc, nil
}

func (r *PostgresRepository) ListForUser(ctx context.Context, userID int64, filter ListFilter) ([]TrackedContract, int, error) {
	var whereClauses []string
	var args []any
	argCount := 1

	whereClauses = append(whereClauses, fmt.Sprintf("uc.user_id = $%d", argCount))
	args = append(args, userID)
	argCount++

	if filter.ChainID > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("c.chain_id = $%d", argCount))
		args = append(args, filter.ChainID)
		argCount++
	}

	if filter.Enabled != nil {
		whereClauses = append(whereClauses, fmt.Sprintf("uc.enabled = $%d", argCount))
		args = append(args, *filter.Enabled)
		argCount++
	}

	if strings.TrimSpace(filter.Search) != "" {
		normalizedSearch := strings.ToLower(strings.TrimSpace(filter.Search))
		whereClauses = append(whereClauses, fmt.Sprintf("(STRPOS(LOWER(uc.label), $%d) > 0 OR STRPOS(LOWER(c.address), $%d) > 0)", argCount, argCount))
		args = append(args, normalizedSearch)
		argCount++
	}

	whereClause := "WHERE " + strings.Join(whereClauses, " AND ")

	countQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM user_contracts uc
		JOIN contracts c ON uc.contract_id = c.id
		%s
	`, whereClause)

	var totalItems int
	err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&totalItems)
	if err != nil {
		return nil, 0, err
	}

	limit := filter.PageSize
	offset := (filter.Page - 1) * filter.PageSize

	selectQuery := fmt.Sprintf(`
		SELECT c.id, c.address, c.chain_id, c.start_block, uc.label, uc.enabled, uc.created_at
		FROM user_contracts uc
		JOIN contracts c ON uc.contract_id = c.id
		%s
		ORDER BY uc.created_at DESC, c.id DESC
		LIMIT $%d OFFSET $%d
	`, whereClause, argCount, argCount+1)

	selectArgs := append(args, limit, offset)

	rows, err := r.db.QueryContext(ctx, selectQuery, selectArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var list []TrackedContract
	for rows.Next() {
		var tc TrackedContract
		err := rows.Scan(&tc.ID, &tc.Address, &tc.ChainID, &tc.StartBlock, &tc.Label, &tc.Enabled, &tc.CreatedAt)
		if err != nil {
			return nil, 0, err
		}
		list = append(list, tc)
	}

	if err = rows.Err(); err != nil {
		return nil, 0, err
	}

	return list, totalItems, nil
}

func (r *PostgresRepository) UpdateTracking(ctx context.Context, userID int64, contractID int64, label *string, enabled *bool) (*TrackedContract, error) {
	var setClauses []string
	var args []any
	argCount := 1

	if label != nil {
		setClauses = append(setClauses, fmt.Sprintf("label = $%d", argCount))
		args = append(args, *label)
		argCount++
	}

	if enabled != nil {
		setClauses = append(setClauses, fmt.Sprintf("enabled = $%d", argCount))
		args = append(args, *enabled)
		argCount++
	}

	setClauses = append(setClauses, "updated_at = NOW()")

	args = append(args, userID, contractID)
	userArgIndex := argCount
	contractArgIndex := argCount + 1

	query := fmt.Sprintf(`
		UPDATE user_contracts
		SET %s
		WHERE user_id = $%d AND contract_id = $%d
	`, strings.Join(setClauses, ", "), userArgIndex, contractArgIndex)

	res, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}

	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}

	if rowsAffected == 0 {
		return nil, ErrContractNotFound
	}

	return r.GetTracking(ctx, userID, contractID)
}

func (r *PostgresRepository) DeleteTracking(ctx context.Context, userID int64, contractID int64) error {
	const query = `
		DELETE FROM user_contracts
		WHERE user_id = $1 AND contract_id = $2
	`
	res, err := r.db.ExecContext(ctx, query, userID, contractID)
	if err != nil {
		return err
	}

	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return err
	}

	if rowsAffected == 0 {
		return ErrContractNotFound
	}

	return nil
}
