package chain

import "context"

type Repository interface {
	ListEnabled(ctx context.Context) ([]Chain, error)
	GetByID(ctx context.Context, id int64) (*Chain, error)
}
