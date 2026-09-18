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

func NewService(repo UserRepository) *Service {
	return &Service{repo: repo}
}

const (
	SessionTTL       = 7 * 24 * time.Hour
	MaxPasswordBytes = 72
	dummyHash = "$2a$10$wN1Qj0Y2k4fG9K1N7l7K5.xQ9V7h7O4T4U6p4Y2Z5X1W8R3S2T1U"
)

func (s *Service) Register(ctx context.Context, email string, password string) (User, error) {

	trimmedEmail := strings.TrimSpace(strings.ToLower(email))

	if trimmedEmail == "" || !strings.Contains(trimmedEmail, "@") {
		return User{}, ErrValidation
	}

	if len(password) > MaxPasswordBytes {
		return User{}, ErrValidation
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

	// tokenHash: sha256(token), base64.RawURLEncoding-encoded (not hex).
	// Must stay identical here, in ValidateSession, and in any test/middleware
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
