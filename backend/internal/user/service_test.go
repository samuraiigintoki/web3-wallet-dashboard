package user

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRegister_PasswordLength(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	s := NewService(repo)

	// Case A: 72-byte string -> success
	pass72 := strings.Repeat("a", 72)
	_, err := s.Register(ctx, "user72@example.com", pass72)
	if err != nil {
		t.Fatalf("expected nil error for 72-byte password, got: %v", err)
	}

	// Case B: 73-byte string -> ErrValidation
	pass73 := strings.Repeat("a", 73)
	_, err = s.Register(ctx, "user73@example.com", pass73)
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation for 73-byte password, got: %v", err)
	}
}

func TestRegister_HashNotPlaintext(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	s := NewService(repo)

	rawPass := "my-secret-password"
	email := "plain@example.com"
	created, err := s.Register(ctx, email, rawPass)
	if err != nil {
		t.Fatalf("unexpected register error: %v", err)
	}

	stored, err := repo.GetByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("failed to retrieve stored user: %v", err)
	}

	if stored.PasswordHash == rawPass {
		t.Fatalf("expected stored password hash to not equal raw password")
	}

	if !strings.HasPrefix(stored.PasswordHash, "$2a$") {
		t.Fatalf("expected bcrypt prefix $2a$, got: %s", stored.PasswordHash)
	}
}

func TestLogin_TimingFloor(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	s := NewService(repo)

	email := "timing@example.com"
	_, err := s.Register(ctx, email, "correct-password")
	if err != nil {
		t.Fatalf("unexpected register error: %v", err)
	}

	start := time.Now()
	_, _, err = s.Login(ctx, email, "wrong-password")
	duration := time.Since(start)

	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("expected ErrInvalidCredentials, got: %v", err)
	}

	if duration < 10*time.Millisecond {
		t.Fatalf("login verification was too fast (%v), expected >= 10ms timing floor", duration)
	}
}

func TestLogin_UnknownEmailAndWrongPassword_IdenticalError(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	s := NewService(repo)

	email := "exists@example.com"
	_, err := s.Register(ctx, email, "correct-password")
	if err != nil {
		t.Fatalf("unexpected register error: %v", err)
	}

	// Unknown email
	_, _, errUnknown := s.Login(ctx, "unknown@example.com", "any-password")
	if !errors.Is(errUnknown, ErrInvalidCredentials) {
		t.Fatalf("expected ErrInvalidCredentials for unknown email, got: %v", errUnknown)
	}

	// Valid email, wrong password
	_, _, errWrongPass := s.Login(ctx, email, "wrong-password")
	if !errors.Is(errWrongPass, ErrInvalidCredentials) {
		t.Fatalf("expected ErrInvalidCredentials for wrong password, got: %v", errWrongPass)
	}
}

func TestValidateSession_Expired(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	s := NewService(repo)

	email := "expire@example.com"
	_, err := s.Register(ctx, email, "secret123")
	if err != nil {
		t.Fatalf("unexpected register error: %v", err)
	}

	token, session, err := s.Login(ctx, email, "secret123")
	if err != nil {
		t.Fatalf("unexpected login error: %v", err)
	}

	// Manually overwrite session's ExpiresAt to the past
	repo.mu.Lock()
	sess := repo.sessions[session.TokenHash]
	sess.ExpiresAt = time.Now().Add(-1 * time.Hour)
	repo.sessions[session.TokenHash] = sess
	repo.mu.Unlock()

	_, err = s.ValidateSession(ctx, token)
	if !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected ErrUnauthenticated for expired session, got: %v", err)
	}
}
