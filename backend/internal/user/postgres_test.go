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

	t.Run("DeleteSessionsByUser removes only that user's rows and returns count", func(t *testing.T) {
		ctx := context.Background()
		userA, err := repo.Create(ctx, User{
			Email:        newUniqueEmail(),
			PasswordHash: "unused-test-hash",
		})
		if err != nil {
			t.Fatalf("create user A: %v", err)
		}
		userB, err := repo.Create(ctx, User{
			Email:        newUniqueEmail(),
			PasswordHash: "unused-test-hash",
		})
		if err != nil {
			t.Fatalf("create user B: %v", err)
		}

		prefix := fmt.Sprintf("revoke-all-%d", time.Now().UnixNano())
		tokenHashesA := []string{prefix + "-a-current", prefix + "-a-other"}
		tokenHashB := prefix + "-b-current"
		for _, tokenHash := range tokenHashesA {
			if _, err := repo.CreateSession(ctx, UserSession{
				UserID:    userA.ID,
				TokenHash: tokenHash,
				ExpiresAt: time.Now().Add(time.Hour),
			}); err != nil {
				t.Fatalf("create user A session %q: %v", tokenHash, err)
			}
		}
		if _, err := repo.CreateSession(ctx, UserSession{
			UserID:    userB.ID,
			TokenHash: tokenHashB,
			ExpiresAt: time.Now().Add(time.Hour),
		}); err != nil {
			t.Fatalf("create user B session: %v", err)
		}
		t.Cleanup(func() {
			for _, tokenHash := range tokenHashesA {
				_ = repo.DeleteSessionByTokenHash(context.Background(), tokenHash)
			}
			_ = repo.DeleteSessionByTokenHash(context.Background(), tokenHashB)
		})

		deleted, err := repo.DeleteSessionsByUser(ctx, userA.ID)
		if err != nil {
			t.Fatalf("delete user A sessions: %v", err)
		}
		if deleted != 2 {
			t.Fatalf("expected 2 deleted rows for user A, got %d", deleted)
		}
		for _, tokenHash := range tokenHashesA {
			if _, err := repo.GetSessionByTokenHash(ctx, tokenHash); !errors.Is(err, ErrNotFound) {
				t.Errorf("expected user A session %q to be deleted, got error %v", tokenHash, err)
			}
		}
		if _, err := repo.GetSessionByTokenHash(ctx, tokenHashB); err != nil {
			t.Fatalf("expected user B session to remain, got error %v", err)
		}
	})

	t.Run("PurgeExpiredSessions deletes only the expired rows", func(t *testing.T) {
		ctx := context.Background()
		u, err := repo.Create(ctx, User{
			Email:        newUniqueEmail(),
			PasswordHash: "unused-test-hash",
		})
		if err != nil {
			t.Fatalf("create user: %v", err)
		}

		prefix := fmt.Sprintf("purge-%d", time.Now().UnixNano())
		expired := []string{prefix + "-expired-one", prefix + "-expired-two"}
		live := prefix + "-live"
		for _, tokenHash := range expired {
			if _, err := repo.CreateSession(ctx, UserSession{
				UserID:    u.ID,
				TokenHash: tokenHash,
				ExpiresAt: time.Now().Add(-1 * time.Hour),
			}); err != nil {
				t.Fatalf("create expired session %q: %v", tokenHash, err)
			}
		}
		if _, err := repo.CreateSession(ctx, UserSession{
			UserID:    u.ID,
			TokenHash: live,
			ExpiresAt: time.Now().Add(time.Hour),
		}); err != nil {
			t.Fatalf("create live session: %v", err)
		}
		t.Cleanup(func() {
			_ = repo.DeleteSessionByTokenHash(context.Background(), live)
		})

		purged, err := repo.PurgeExpiredSessions(ctx)
		if err != nil {
			t.Fatalf("purge expired sessions: %v", err)
		}
		if purged < int64(len(expired)) {
			t.Fatalf("purged %d rows, want at least the %d this test seeded", purged, len(expired))
		}

		for _, tokenHash := range expired {
			if _, err := repo.GetSessionByTokenHash(ctx, tokenHash); !errors.Is(err, ErrNotFound) {
				t.Errorf("expected expired session %q to be gone, got error %v", tokenHash, err)
			}
		}
		if _, err := repo.GetSessionByTokenHash(ctx, live); err != nil {
			t.Errorf("expected the live session to survive the purge, got error %v", err)
		}

		purged, err = repo.PurgeExpiredSessions(ctx)
		if err != nil {
			t.Fatalf("repeat purge: %v", err)
		}
		if purged != 0 {
			t.Errorf("repeat purge deleted %d rows, want 0", purged)
		}
	})
}
