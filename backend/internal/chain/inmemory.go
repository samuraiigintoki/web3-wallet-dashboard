package chain

import (
	"context"
	"sort"
	"sync"
)

type InMemoryRepository struct {
	mu     sync.RWMutex
	chains map[int64]Chain
}

func NewInMemoryRepository() *InMemoryRepository {
	return &InMemoryRepository{
		chains: make(map[int64]Chain),
	}
}

func (repo *InMemoryRepository) Seed(chains ...Chain) {
	repo.mu.Lock()
	defer repo.mu.Unlock()

	for _, c := range chains {
		repo.chains[c.ChainID] = c
	}
}

func (repo *InMemoryRepository) ListEnabled(ctx context.Context) ([]Chain, error) {

	if err := ctx.Err(); err != nil {
		return nil, err
	}

	repo.mu.RLock()
	defer repo.mu.RUnlock()

	var out []Chain
	for _, c := range repo.chains {
		if c.Enabled {
			out = append(out, c)
		}
	}

	// Parity with Postgres ORDER BY chain_id
	sort.Slice(out, func(i, j int) bool {
		return out[i].ChainID < out[j].ChainID
	})

	return out, nil
}

func (repo *InMemoryRepository) GetByID(ctx context.Context, id int64) (*Chain, error) {

	if err := ctx.Err(); err != nil {
		return nil, err
	}

	repo.mu.RLock()
	defer repo.mu.RUnlock()

	c, ok := repo.chains[id]
	if !ok {
		return nil, ErrNotFound
	}

	return &c, nil
}
