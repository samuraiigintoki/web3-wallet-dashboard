package wallet

import "fmt"

type InMemoryWalletRepo struct {
	wallets []Wallet
	counter int
}

// Create implements [WalletRepository].
func (repo *InMemoryWalletRepo) Create(w Wallet) (Wallet, error) {
	for _, existing := range repo.wallets {
		if existing.Address == w.Address && existing.ChainID == w.ChainID {
			return Wallet{}, ErrWalletDuplicate
		}
	}

	repo.counter++
	w.ID = fmt.Sprintf("w%d", repo.counter)

	repo.wallets = append(repo.wallets, w)

	return w, nil
}

// GetByID implements [WalletRepository].
func (repo *InMemoryWalletRepo) GetByID(id string) (Wallet, error) {
	for _, w := range repo.wallets {
		if w.ID == id {
			return w, nil
		}
	}

	return Wallet{}, ErrWalletNotFound
}

func NewInMemoryWalletRepo() *InMemoryWalletRepo {
	return &InMemoryWalletRepo{
		wallets: make([]Wallet, 0),
		counter: 0,
	}
}
