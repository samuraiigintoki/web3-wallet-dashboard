package wallet

import (
	"context"
	"sort"
	"strings"
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

func (repo *InMemoryWalletRepo) List(ctx context.Context, filter WalletFilter) ([]Wallet, int64, error) {
	filtered := make([]Wallet, 0)
	searchLower := strings.ToLower(filter.Search)

	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}

	for _, w := range repo.wallets{
		if filter.ChainID > 0 && w.ChainID != filter.ChainID {
			continue
		}

		if filter.Search != "" {
			if !strings.Contains(strings.ToLower(w.Label), searchLower) && !strings.Contains(strings.ToLower(w.Address), searchLower) {
				continue
			}
		}

		
		filtered = append(filtered, w)
	}
	
	totalItems := int64(len(filtered))

	// sorting
	sort.Slice(filtered, func(i, j int) bool {
		if filtered[i].CreatedAt.Equal(filtered[j].CreatedAt) {
			return filtered[i].ID > filtered[j].ID
		}
		return filtered[i].CreatedAt.After(filtered[j].CreatedAt)
	})

	offset:= (filter.Page - 1) * filter.PageSize

	if offset < 0 || offset >= len(filtered) {
		return  make([]Wallet, 0), totalItems, nil
	}

	end := offset + filter.PageSize
	if end >= len(filtered) {
		end = len(filtered)
	}

	return filtered[offset:end], totalItems, nil 
}
