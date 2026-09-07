package wallet

import (
	"context"
	"errors"
)

var ErrWalletDuplicate = errors.New("wallet address already exists on this chain")
var ErrWalletNotFound = errors.New("wallet not found")

type WalletRepository interface {
	Create(ctx context.Context,w Wallet) (Wallet, error)
	GetByID(ctx context.Context,id int64) (Wallet, error)
}
