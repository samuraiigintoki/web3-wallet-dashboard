package contract

import "context"

type Repository interface {
	GetOrCreateDeployment(ctx context.Context, chainID int64, address string, startBlock int64) (*Contract, error)
	InsertTracking(ctx context.Context, userID int64, contractID int64, label string, enabled bool) error
	GetTracking(ctx context.Context, userID int64, contractID int64) (*TrackedContract, error)
	ListForUser(ctx context.Context, userID int64, filter ListFilter) ([]TrackedContract, int, error)
	UpdateTracking(ctx context.Context, userID int64, contractID int64, label *string, enabled *bool) (*TrackedContract, error)
	DeleteTracking(ctx context.Context, userID int64, contractID int64) error
}
