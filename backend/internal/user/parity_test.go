package user_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
)

type sessionRevocationRepository interface {
	CreateSession(ctx context.Context, session user.UserSession) (user.UserSession, error)
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (user.UserSession, error)
	DeleteSessionsByUser(ctx context.Context, userID int64) (int64, error)
}

type sessionRevocationUsers struct {
	owner int64
	other int64
}

type sessionRevocationObservation struct {
	Step string
	Got  string
}

func TestParity_DeleteSessionsByUser_InMemory(t *testing.T) {
	_ = runSessionRevocationScenario(
		t,
		user.NewInMemoryRepository(),
		sessionRevocationUsers{owner: 1, other: 2},
		fmt.Sprintf("memory-%d", time.Now().UnixNano()),
	)
}

func TestParity_DeleteSessionsByUser_Postgres(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	ctx := context.Background()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping db: %v", err)
	}

	repo := user.NewPostgresUserRepository(db)
	userIDs := make([]int64, 0, 2)
	t.Cleanup(func() {
		for _, id := range userIDs {
			_, _ = db.ExecContext(context.Background(), "DELETE FROM user_sessions WHERE user_id = $1", id)
			_, _ = db.ExecContext(context.Background(), "DELETE FROM users WHERE id = $1", id)
		}
	})

	stamp := time.Now().UnixNano()
	owner, err := repo.Create(ctx, user.User{
		Email:        fmt.Sprintf("revoke-parity-%d-owner@example.com", stamp),
		PasswordHash: "unused-parity-hash",
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	userIDs = append(userIDs, owner.ID)
	other, err := repo.Create(ctx, user.User{
		Email:        fmt.Sprintf("revoke-parity-%d-other@example.com", stamp),
		PasswordHash: "unused-parity-hash",
	})
	if err != nil {
		t.Fatalf("create other user: %v", err)
	}
	userIDs = append(userIDs, other.ID)

	prefix := fmt.Sprintf("revoke-parity-%d", stamp)
	memoryObservations := runSessionRevocationScenario(
		t,
		user.NewInMemoryRepository(),
		sessionRevocationUsers{owner: 1, other: 2},
		prefix,
	)
	postgresObservations := runSessionRevocationScenario(
		t,
		repo,
		sessionRevocationUsers{owner: owner.ID, other: other.ID},
		prefix,
	)

	if !reflect.DeepEqual(memoryObservations, postgresObservations) {
		t.Errorf("parity mismatch:\nmem:%+v\npg:%+v", memoryObservations, postgresObservations)
	}
}

func runSessionRevocationScenario(
	t *testing.T,
	repo sessionRevocationRepository,
	users sessionRevocationUsers,
	prefix string,
) []sessionRevocationObservation {
	t.Helper()
	ctx := context.Background()

	sessions := []struct {
		name   string
		userID int64
	}{
		{name: "owner-current", userID: users.owner},
		{name: "owner-other", userID: users.owner},
		{name: "other-current", userID: users.other},
	}
	tokenHashes := make(map[string]string, len(sessions))
	for _, session := range sessions {
		tokenHash := prefix + "-" + session.name
		if _, err := repo.CreateSession(ctx, user.UserSession{
			UserID:    session.userID,
			TokenHash: tokenHash,
			ExpiresAt: time.Now().Add(time.Hour),
		}); err != nil {
			t.Fatalf("create %s session: %v", session.name, err)
		}
		tokenHashes[session.name] = tokenHash
	}

	observations := make([]sessionRevocationObservation, 0, 5)
	deleted, err := repo.DeleteSessionsByUser(ctx, users.owner)
	if err != nil {
		t.Fatalf("delete owner's sessions: %v", err)
	}
	if deleted != 2 {
		t.Fatalf("expected 2 deleted sessions for owner, got %d", deleted)
	}
	observations = append(observations, sessionRevocationObservation{Step: "delete-owner", Got: fmt.Sprint(deleted)})

	for _, session := range sessions {
		_, err := repo.GetSessionByTokenHash(ctx, tokenHashes[session.name])
		if session.userID == users.owner {
			if !errors.Is(err, user.ErrNotFound) {
				t.Fatalf("expected %s session to be deleted, got error %v", session.name, err)
			}
			observations = append(observations, sessionRevocationObservation{Step: session.name, Got: "deleted"})
			continue
		}
		if err != nil {
			t.Fatalf("expected %s session to remain, got error %v", session.name, err)
		}
		observations = append(observations, sessionRevocationObservation{Step: session.name, Got: "present"})
	}

	deleted, err = repo.DeleteSessionsByUser(ctx, users.owner)
	if err != nil {
		t.Fatalf("repeat delete owner's sessions: %v", err)
	}
	if deleted != 0 {
		t.Fatalf("expected repeat revoke to delete 0 sessions, got %d", deleted)
	}
	observations = append(observations, sessionRevocationObservation{Step: "repeat-delete-owner", Got: fmt.Sprint(deleted)})

	return observations
}
