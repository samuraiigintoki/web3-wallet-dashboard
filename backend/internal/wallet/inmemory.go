package wallet

import (
	"context"
	"slices"
	"sort"
	"strings"
	"time"
)

// walletRecord keeps the owning user beside the wallet itself. The owner is a
// query scope, not a Wallet field, so the domain type stays identical to the
// response DTO shape.
type walletRecord struct {
	UserID int64
	Wallet Wallet
}

type InMemoryWalletRepo struct {
	wallets []walletRecord
	counter int64
}

func NewInMemoryWalletRepo() *InMemoryWalletRepo {
	return &InMemoryWalletRepo{
		wallets: make([]walletRecord, 0),
		counter: 0,
	}
}

// Create implements [WalletRepository].
func (repo *InMemoryWalletRepo) Create(ctx context.Context, userID int64, w Wallet) (Wallet, error) {
	if err := ctx.Err(); err != nil {
		return Wallet{}, err
	}

	for _, existing := range repo.wallets {
		if existing.UserID == userID && existing.Wallet.Address == w.Address && existing.Wallet.ChainID == w.ChainID {
			return Wallet{}, ErrWalletDuplicate
		}
	}

	repo.counter++
	w.ID = repo.counter
	w.CreatedAt = time.Now().UTC()

	repo.wallets = append(repo.wallets, walletRecord{UserID: userID, Wallet: w})

	return w, nil
}

// GetByID implements [WalletRepository].
func (repo *InMemoryWalletRepo) GetByID(ctx context.Context, userID int64, id int64) (Wallet, error) {
	if err := ctx.Err(); err != nil {
		return Wallet{}, err
	}

	for _, rec := range repo.wallets {
		if rec.UserID == userID && rec.Wallet.ID == id {
			return rec.Wallet, nil
		}
	}

	return Wallet{}, ErrWalletNotFound
}

func (repo *InMemoryWalletRepo) List(ctx context.Context, userID int64, filter WalletFilter) ([]Wallet, int64, error) {
	filtered := make([]Wallet, 0)
	searchLower := strings.ToLower(filter.Search)

	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}

	for _, rec := range repo.wallets {
		if rec.UserID != userID {
			continue
		}

		w := rec.Wallet

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

	offset := (filter.Page - 1) * filter.PageSize

	if offset < 0 || offset >= len(filtered) {
		return make([]Wallet, 0), totalItems, nil
	}

	end := offset + filter.PageSize
	if end >= len(filtered) {
		end = len(filtered)
	}

	return filtered[offset:end], totalItems, nil
}

func (repo *InMemoryWalletRepo) Update(ctx context.Context, userID int64, id int64, newLabel string) (Wallet, error) {
	if err := ctx.Err(); err != nil {
		return Wallet{}, err
	}

	for i := range repo.wallets {
		if repo.wallets[i].UserID == userID && repo.wallets[i].Wallet.ID == id {
			repo.wallets[i].Wallet.Label = newLabel
			return repo.wallets[i].Wallet, nil
		}
	}

	return Wallet{}, ErrWalletNotFound
}

func (repo *InMemoryWalletRepo) Delete(ctx context.Context, userID int64, id int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	found := false

	repo.wallets = slices.DeleteFunc(repo.wallets, func(rec walletRecord) bool {
		if rec.UserID == userID && rec.Wallet.ID == id {
			found = true
			return true
		}
		return false
	})

	if !found {
		return ErrWalletNotFound
	}

	return nil
}
