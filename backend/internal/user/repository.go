package user

import "context"

type UserRepository interface {
	Create(ctx context.Context, u User) (User, error)
	GetByEmail(ctx context.Context, email string) (User, error)
	GetByID(ctx context.Context, id int64) (User, error)
	CreateSession(ctx context.Context, s UserSession) (UserSession, error)
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (UserSession, error)
	DeleteSessionByTokenHash(ctx context.Context, tokenHash string) error
}
