package wallet

import (
	"context"
	"time"
)

type InMemoryWalletRepo struct {
	wallets []Wallet
	counter int64
}

func NewInMemoryWalletRepo() *InMemoryWalletRepo {
	return &InMemoryWalletRepo{
		wallets: make([]Wallet, 0),
		counter: 0,
	}
}

// Create implements [WalletRepository].
func (repo *InMemoryWalletRepo) Create(ctx context.Context, w Wallet) (Wallet, error) {
	for _, existing := range repo.wallets {
		if existing.Address == w.Address && existing.ChainID == w.ChainID {
			return Wallet{}, ErrWalletDuplicate
		}
	}

	repo.counter++
	w.ID = repo.counter
	w.CreatedAt = time.Now().UTC()

	repo.wallets = append(repo.wallets, w)

	return w, nil
}

// GetByID implements [WalletRepository].
func (repo *InMemoryWalletRepo) GetByID(ctx context.Context, id int64) (Wallet, error) {
	for _, w := range repo.wallets {
		if w.ID == id {
			return w, nil
		}
	}

	return Wallet{}, ErrWalletNotFound
}
