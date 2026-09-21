package user

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Service struct {
	repo UserRepository
}

func NewService(r UserRepository) *Service {
	return &Service{repo: r}
}

const (
	SessionTTL       = 7 * 24 * time.Hour
	MaxPasswordBytes = 72
)

// timing-oracle mitigation: dynamically generate a cryptographically valid 60-byte
// cost-10 bcrypt hash at init time (pinning minHashSize=59 dependence in x/crypto/bcrypt).
var dummyHash string

func init() {
	hash, err := bcrypt.GenerateFromPassword([]byte("dummy-password-value"), bcrypt.DefaultCost)
	if err != nil {
		panic("failed to generate dummy bcrypt hash: " + err.Error())
	}
	dummyHash = string(hash)
}

func (s *Service) Register(ctx context.Context, email, password string) (User, error) {
	trimmedEmail := strings.TrimSpace(strings.ToLower(email))
	if trimmedEmail == "" || !strings.Contains(trimmedEmail, "@") {
		return User{}, &ValidationError{Field: "email", Message: "must contain @"}
	}
	if len(password) > MaxPasswordBytes {
		return User{}, &ValidationError{Field: "password", Message: "password exceeds maximum allowed length of 72 bytes"}
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, fmt.Errorf("hash password: %w", err)
	}

	return s.repo.Create(ctx, User{
		Email:        trimmedEmail,
		PasswordHash: string(hash),
	})
}

func (s *Service) Login(ctx context.Context, email, password string) (string, UserSession, error) {
	trimmedEmail := strings.TrimSpace(strings.ToLower(email))

	user, err := s.repo.GetByEmail(ctx, trimmedEmail)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			// timing-oracle mitigation: burn identical cost-10 CPU cycles against dummyHash
			_ = bcrypt.CompareHashAndPassword([]byte(dummyHash), []byte(password))
			return "", UserSession{}, ErrInvalidCredentials
		}
		return "", UserSession{}, err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return "", UserSession{}, ErrInvalidCredentials
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", UserSession{}, fmt.Errorf("generate token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	sum := sha256.Sum256([]byte(token))
	tokenHash := base64.RawURLEncoding.EncodeToString(sum[:])

	session, err := s.repo.CreateSession(ctx, UserSession{
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(SessionTTL),
	})

	return token, session, err
}

func (s *Service) ValidateSession(ctx context.Context, token string) (User, error) {
	sum := sha256.Sum256([]byte(token))
	tokenHash := base64.RawURLEncoding.EncodeToString(sum[:])

	session, err := s.repo.GetSessionByTokenHash(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return User{}, ErrUnauthenticated
		}
		return User{}, err
	}

	if time.Now().After(session.ExpiresAt) {
		return User{}, ErrUnauthenticated
	}

	user, err := s.repo.GetByID(ctx, session.UserID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return User{}, ErrUnauthenticated
		}
		return User{}, err
	}

	return user, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	sum := sha256.Sum256([]byte(token))
	tokenHash := base64.RawURLEncoding.EncodeToString(sum[:])
	return s.repo.DeleteSessionByTokenHash(ctx, tokenHash)
}
