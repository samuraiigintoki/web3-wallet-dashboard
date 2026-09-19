package user

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestPostgresUserRepository_Integration(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("skipping integration test: DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	if err := db.Ping(); err != nil {
		t.Fatalf("failed to ping database: %v", err)
	}

	repo := NewPostgresUserRepository(db)

	newUniqueEmail := func() string {
		return fmt.Sprintf("test-%d@example.com", time.Now().UnixNano())
	}

	t.Run("Duplicate email returns typed error", func(t *testing.T) {
		ctx := context.Background()
		e1 := newUniqueEmail()
		u1 := User{
			Email:        e1,
			PasswordHash: "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
		}
		_, err := repo.Create(ctx, u1)
		if err != nil {
			t.Fatalf("unexpected error creating first user: %v", err)
		}

		u2 := User{
			Email:        strings.ToUpper(e1),
			PasswordHash: "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
		}
		_, err = repo.Create(ctx, u2)
		if !errors.Is(err, ErrDuplicateEmail) {
			t.Fatalf("expected ErrDuplicateEmail, got: %v", err)
		}
	})

	t.Run("GetByEmail returns ErrNotFound", func(t *testing.T) {
		ctx := context.Background()
		_, err := repo.GetByEmail(ctx, "doesnotexist-"+newUniqueEmail())
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("expected ErrNotFound, got: %v", err)
		}
	})

	t.Run("Context cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		_, err := repo.GetByEmail(ctx, newUniqueEmail())
		if err == nil {
			t.Fatalf("expected error on cancelled context, got nil")
		}
		if !errors.Is(err, context.Canceled) && !strings.Contains(err.Error(), "context canceled") {
			t.Fatalf("expected context canceled error, got: %v", err)
		}
	})

	t.Run("Session lifecycle", func(t *testing.T) {
		ctx := context.Background()
		u, err := repo.Create(ctx, User{
			Email:        newUniqueEmail(),
			PasswordHash: "$2a$10$fakehashforuser1234567890abcdefghijklmnopqr",
		})
		if err != nil {
			t.Fatalf("failed to create user for session test: %v", err)
		}

		tokenHash := "fake-sha256-hash-1"
		expiresAt := time.Now().Add(24 * time.Hour).Truncate(time.Microsecond)
		sess, err := repo.CreateSession(ctx, UserSession{
			UserID:    u.ID,
			TokenHash: tokenHash,
			ExpiresAt: expiresAt,
		})
		if err != nil {
			t.Fatalf("failed to create session: %v", err)
		}

		fetched, err := repo.GetSessionByTokenHash(ctx, tokenHash)
		if err != nil {
			t.Fatalf("failed to get session by token hash: %v", err)
		}
		if fetched.ID != sess.ID || fetched.UserID != u.ID || fetched.TokenHash != tokenHash {
			t.Fatalf("fetched session mismatch: got %+v, want %+v", fetched, sess)
		}

		err = repo.DeleteSessionByTokenHash(ctx, tokenHash)
		if err != nil {
			t.Fatalf("failed to delete session: %v", err)
		}

		_, err = repo.GetSessionByTokenHash(ctx, tokenHash)
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("expected ErrNotFound after session deletion, got: %v", err)
		}
	})
}