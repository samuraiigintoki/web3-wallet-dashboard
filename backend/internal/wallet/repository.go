package wallet

import (
	"context"
	"errors"
)

var ErrWalletDuplicate = errors.New("wallet address already exists on this chain")
var ErrWalletNotFound = errors.New("wallet not found")

type WalletFilter struct {
	Page     int
	PageSize int
	ChainID  int64
	Search   string
}

// WalletRepository scopes every operation to an owning user. Ownership is a
// query scope rather than a Wallet field, matching contract.Repository: a
// record that exists under another user is reported as not found, never as
// forbidden, so ids cannot be probed across accounts.
type WalletRepository interface {
	Create(ctx context.Context, userID int64, w Wallet) (Wallet, error)
	GetByID(ctx context.Context, userID int64, id int64) (Wallet, error)
	List(ctx context.Context, userID int64, filter WalletFilter) ([]Wallet, int64, error)
	Update(ctx context.Context, userID int64, id int64, newLabel string) (Wallet, error)
	Delete(ctx context.Context, userID int64, id int64) error
}
