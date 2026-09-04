package wallet

import "errors"

var ErrWalletDuplicate = errors.New("wallet address already exists on this chain")
var ErrWalletNotFound = errors.New("wallet not found")

type WalletRepository interface {
	Create(Wallet) (Wallet, error)
	GetByID(id string) (Wallet, error)
}
