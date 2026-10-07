package user

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// testPassword satisfies the registration policy: 21 code points, 21 bytes.
// Fixtures use it so a password rule change never silently weakens a test.
const testPassword = "correct-horse-battery"

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

	// Case B: 73-byte string -> ValidationError on password field
	pass73 := strings.Repeat("a", 73)
	_, err = s.Register(ctx, "user73@example.com", pass73)
	var valErr *ValidationError
	if !errors.As(err, &valErr) {
		t.Fatalf("expected ValidationError for 73-byte password, got: %v", err)
	}
	if valErr.Field != "password" {
		t.Fatalf("expected ValidationError field to be 'password', got: %s", valErr.Field)
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

	_, err := s.Register(ctx, "registered@example.com", testPassword)
	if err != nil {
		t.Fatalf("unexpected error registering user: %v", err)
	}

	t.Run("Unknown_Email_path", func(t *testing.T) {
		start := time.Now()
		_, _, err := s.Login(ctx, "unknown@example.com", "any-password")
		elapsed := time.Since(start)

		if !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("expected ErrInvalidCredentials, got: %v", err)
		}
		if elapsed < 10*time.Millisecond {
			t.Fatalf("unknown email login was too fast (%v), expected >= 10ms timing floor", elapsed)
		}
	})

	t.Run("Wrong_Password_path", func(t *testing.T) {
		start := time.Now()
		_, _, err := s.Login(ctx, "registered@example.com", "wrong-password")
		elapsed := time.Since(start)

		if !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("expected ErrInvalidCredentials, got: %v", err)
		}
		if elapsed < 10*time.Millisecond {
			t.Fatalf("wrong password login was too fast (%v), expected >= 10ms timing floor", elapsed)
		}
	})
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
	_, err := s.Register(ctx, email, testPassword)
	if err != nil {
		t.Fatalf("unexpected register error: %v", err)
	}

	token, session, err := s.Login(ctx, email, testPassword)
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

func TestRevokeAll_RemovesOnlyTheUsersSessions(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	service := NewService(repo)

	const userA int64 = 101
	const userB int64 = 202
	sessions := []UserSession{
		{UserID: userA, TokenHash: "user-a-current", ExpiresAt: time.Now().Add(time.Hour)},
		{UserID: userA, TokenHash: "user-a-other", ExpiresAt: time.Now().Add(time.Hour)},
		{UserID: userB, TokenHash: "user-b-current", ExpiresAt: time.Now().Add(time.Hour)},
	}
	for _, session := range sessions {
		if _, err := repo.CreateSession(ctx, session); err != nil {
			t.Fatalf("create session %q: %v", session.TokenHash, err)
		}
	}

	deleted, err := service.RevokeAll(ctx, userA)
	if err != nil {
		t.Fatalf("revoke all sessions: %v", err)
	}
	if deleted != 2 {
		t.Fatalf("expected 2 deleted sessions for user A, got %d", deleted)
	}

	for _, tokenHash := range []string{"user-a-current", "user-a-other"} {
		if _, err := repo.GetSessionByTokenHash(ctx, tokenHash); !errors.Is(err, ErrNotFound) {
			t.Errorf("expected user A session %q to be deleted, got error %v", tokenHash, err)
		}
	}
	if _, err := repo.GetSessionByTokenHash(ctx, "user-b-current"); err != nil {
		t.Fatalf("expected user B session to remain, got error %v", err)
	}
}

func TestPurgeExpiredSessions_RemovesOnlyExpiredSessions(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	service := NewService(repo)

	sessions := []UserSession{
		{UserID: 1, TokenHash: "expired-one", ExpiresAt: time.Now().Add(-2 * time.Hour)},
		{UserID: 1, TokenHash: "live", ExpiresAt: time.Now().Add(time.Hour)},
		{UserID: 2, TokenHash: "expired-two", ExpiresAt: time.Now().Add(-time.Minute)},
	}
	for _, session := range sessions {
		if _, err := repo.CreateSession(ctx, session); err != nil {
			t.Fatalf("create session %q: %v", session.TokenHash, err)
		}
	}

	purged, err := service.PurgeExpiredSessions(ctx)
	if err != nil {
		t.Fatalf("purge expired sessions: %v", err)
	}
	if purged != 2 {
		t.Fatalf("expected 2 purged sessions, got %d", purged)
	}

	for _, tokenHash := range []string{"expired-one", "expired-two"} {
		if _, err := repo.GetSessionByTokenHash(ctx, tokenHash); !errors.Is(err, ErrNotFound) {
			t.Errorf("expected session %q to be purged, got error %v", tokenHash, err)
		}
	}
	if _, err := repo.GetSessionByTokenHash(ctx, "live"); err != nil {
		t.Fatalf("expected the live session to survive, got error %v", err)
	}
}

// TestRegister_PasswordPolicy pins the registration rule: at least 15 code
// points, at most 72 bytes, not blank, measured on the exact received string.
func TestRegister_PasswordPolicy(t *testing.T) {
	const (
		blankMessage = "password must not be blank"
		shortMessage = "password must be at least 15 characters"
		bytesMessage = "password exceeds maximum allowed length of 72 bytes"
	)

	cases := []struct {
		name     string
		password string
		message  string // empty means the registration must succeed
	}{
		{name: "empty", password: "", message: blankMessage},
		{name: "one character", password: "a", message: shortMessage},
		{name: "fourteen characters", password: strings.Repeat("a", 14), message: shortMessage},
		{name: "fifteen characters", password: strings.Repeat("a", 15)},
		{name: "sixteen characters", password: strings.Repeat("a", 16)},
		// Two bytes per code point: the count that matters is the code points.
		{name: "fourteen two-byte code points", password: strings.Repeat("é", 14), message: shortMessage},
		{name: "fifteen two-byte code points", password: strings.Repeat("é", 15)},
		// Four bytes per code point: 60 bytes, well inside the ceiling.
		{name: "fifteen four-byte code points", password: strings.Repeat("𝄞", 15)},
		// The ceiling is bytes, so 18 four-byte code points is exactly 72.
		{name: "eighteen four-byte code points", password: strings.Repeat("𝄞", 18)},
		{name: "nineteen four-byte code points", password: strings.Repeat("𝄞", 19), message: bytesMessage},
		// Whitespace is blank however long it is, so it never reports short.
		{name: "five spaces", password: "     ", message: blankMessage},
		{name: "fifteen spaces", password: strings.Repeat(" ", 15), message: blankMessage},
	}

	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			repo := NewInMemoryRepository()
			s := NewService(repo)
			email := fmt.Sprintf("policy%d@example.com", index)

			_, err := s.Register(ctx, email, testCase.password)

			if testCase.message == "" {
				if err != nil {
					t.Fatalf("expected the registration to succeed, got: %v", err)
				}
				return
			}

			var valErr *ValidationError
			if !errors.As(err, &valErr) {
				t.Fatalf("expected a ValidationError, got: %v", err)
			}
			if valErr.Field != "password" {
				t.Fatalf("expected field password, got: %s", valErr.Field)
			}
			if valErr.Message != testCase.message {
				t.Fatalf("expected message %q, got: %q", testCase.message, valErr.Message)
			}
		})
	}
}

// TestRegister_PasswordNotTrimmed proves the password is stored exactly as
// received. Trimming here would let a different string open the account.
func TestRegister_PasswordNotTrimmed(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	s := NewService(repo)

	padded := "  " + strings.Repeat("a", 15) + "  "
	email := "untrimmed@example.com"

	if _, err := s.Register(ctx, email, padded); err != nil {
		t.Fatalf("expected the padded password to be accepted, got: %v", err)
	}

	if _, _, err := s.Login(ctx, email, padded); err != nil {
		t.Fatalf("expected login with the exact password to succeed, got: %v", err)
	}

	if _, _, err := s.Login(ctx, email, strings.TrimSpace(padded)); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("expected login with the trimmed password to fail, got: %v", err)
	}
}

// TestRegister_RejectedPasswordCreatesNoRow checks the rule runs before the
// repository is touched, so a rejected attempt leaves nothing behind.
func TestRegister_RejectedPasswordCreatesNoRow(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	s := NewService(repo)
	email := "norow@example.com"

	if _, err := s.Register(ctx, email, "short"); err == nil {
		t.Fatal("expected the short password to be rejected")
	}

	if _, err := repo.GetByEmail(ctx, email); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected no stored user, got: %v", err)
	}
}

// TestLogin_IgnoresTheRegistrationMinimum covers accounts created before the
// minimum existed. The floor applies where a password is set, and rejecting
// these at login would lock them out without strengthening any stored hash.
func TestLogin_IgnoresTheRegistrationMinimum(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryRepository()
	s := NewService(repo)

	legacy := []struct {
		email    string
		password string
	}{
		{email: "legacy-short@example.com", password: "a"},
		{email: "legacy-empty@example.com", password: ""},
	}

	for _, account := range legacy {
		// Inserted through the repository, bypassing the service, because the
		// service can no longer create a password this weak.
		hash, err := bcrypt.GenerateFromPassword([]byte(account.password), bcrypt.DefaultCost)
		if err != nil {
			t.Fatalf("hash the legacy password: %v", err)
		}
		if _, err := repo.Create(ctx, User{Email: account.email, PasswordHash: string(hash)}); err != nil {
			t.Fatalf("insert the legacy user: %v", err)
		}
	}

	for _, account := range legacy {
		if _, _, err := s.Login(ctx, account.email, account.password); err != nil {
			t.Fatalf("expected %s to still log in, got: %v", account.email, err)
		}
	}
}
