package user

import (
	"context"
	"strings"
	"sync"
	"time"
)

type InMemoryRepository struct {
	mu            sync.RWMutex
	users         map[int64]User
	sessions      map[string]UserSession
	nextUserID    int64
	nextSessionID int64
}

func NewInMemoryRepository() *InMemoryRepository {
	return &InMemoryRepository{
		users:         make(map[int64]User),
		sessions:      make(map[string]UserSession),
		nextUserID:    1,
		nextSessionID: 1,
	}
}

func (r *InMemoryRepository) Create(ctx context.Context, u User) (User, error) {
	if err := ctx.Err(); err != nil {
		return User{}, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	for _, existing := range r.users {
		if strings.EqualFold(existing.Email, u.Email) {
			return User{}, ErrDuplicateEmail
		}
	}

	u.ID = r.nextUserID
	r.nextUserID++
	u.CreatedAt = time.Now()

	r.users[u.ID] = u
	return u, nil
}

func (r *InMemoryRepository) GetByEmail(ctx context.Context, email string) (User, error) {
	if err := ctx.Err(); err != nil {
		return User{}, err
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, existing := range r.users {
		if strings.EqualFold(existing.Email, email) {
			return existing, nil
		}
	}

	return User{}, ErrNotFound
}

func (r *InMemoryRepository) GetByID(ctx context.Context, id int64) (User, error) {
	if err := ctx.Err(); err != nil {
		return User{}, err
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	u, ok := r.users[id]
	if !ok {
		return User{}, ErrNotFound
	}

	return u, nil
}

func (r *InMemoryRepository) CreateSession(ctx context.Context, s UserSession) (UserSession, error) {
	if err := ctx.Err(); err != nil {
		return UserSession{}, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	s.ID = r.nextSessionID
	r.nextSessionID++
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}

	r.sessions[s.TokenHash] = s
	return s, nil
}

func (r *InMemoryRepository) GetSessionByTokenHash(ctx context.Context, tokenHash string) (UserSession, error) {
	if err := ctx.Err(); err != nil {
		return UserSession{}, err
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	s, ok := r.sessions[tokenHash]
	if !ok {
		return UserSession{}, ErrNotFound
	}

	return s, nil
}

func (r *InMemoryRepository) DeleteSessionByTokenHash(ctx context.Context, tokenHash string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.sessions, tokenHash)
	return nil
}
