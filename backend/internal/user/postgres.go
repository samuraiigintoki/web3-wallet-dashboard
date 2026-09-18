package user

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

type PostgresUserRepository struct {
	db *sql.DB
}

func NewPostgresUserRepository(db *sql.DB) *PostgresUserRepository {
	return &PostgresUserRepository{
		db: db,
	}
}

func (repo *PostgresUserRepository) Create(ctx context.Context, u User) (User, error) {

	const query = `
		INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, created_at
	`
	err := repo.db.QueryRowContext(ctx, query, u.Email, u.PasswordHash).Scan(&u.ID, &u.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && (pgErr.ConstraintName == "idx_users_email_lower" || strings.Contains(pgErr.ConstraintName, "email")) {
			return User{}, ErrDuplicateEmail
		}
		return User{}, err
	}

	return u, nil
}

func (repo *PostgresUserRepository) GetByID(ctx context.Context, id int64) (User, error) {

	const query = `SELECT id, email, password_hash, created_at FROM users WHERE id = $1`

	var u User
	err := repo.db.QueryRowContext(ctx, query, id).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}

	return u, nil
}

func (repo *PostgresUserRepository) GetByEmail(ctx context.Context, email string) (User, error) {

	const query = `SELECT id, email, password_hash, created_at FROM users WHERE LOWER(email) = LOWER($1)`

	var u User
	err := repo.db.QueryRowContext(ctx, query, email).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}

	return u, nil
}

func (repo *PostgresUserRepository) CreateSession(ctx context.Context, s UserSession) (UserSession, error) {
	const query = `INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id, created_at`

	err := repo.db.QueryRowContext(ctx, query, s.UserID, s.TokenHash, s.ExpiresAt).Scan(&s.ID, &s.CreatedAt)
	if err != nil {
		return UserSession{}, err
	}

	return s, nil
}

func (repo *PostgresUserRepository) GetSessionByTokenHash(ctx context.Context, tokenHash string) (UserSession, error) {

	const query = `SELECT id, user_id, token_hash, expires_at, created_at FROM user_sessions WHERE token_hash = $1`

	var s UserSession
	err := repo.db.QueryRowContext(ctx, query, tokenHash).Scan(&s.ID, &s.UserID, &s.TokenHash, &s.ExpiresAt, &s.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return UserSession{}, ErrNotFound
		}
		return UserSession{}, err
	}

	return s, nil
}

func (repo *PostgresUserRepository) DeleteSessionByTokenHash(ctx context.Context, tokenHash string) error {
	const query = `DELETE FROM user_sessions WHERE token_hash = $1`

	_, err := repo.db.ExecContext(ctx, query, tokenHash)
	if err != nil {
		return err
	}

	return nil
}
