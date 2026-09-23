package contract

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

var _ Repository = (*InMemoryRepository)(nil)

type userContractRecord struct {
	UserID     int64
	ContractID int64
	Label      string
	Enabled    bool
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type InMemoryRepository struct {
	mu              sync.RWMutex
	deployments     map[string]*Contract
	deploymentsByID map[int64]*Contract
	userContracts   map[string]*userContractRecord
	nextContractID  int64
}

func NewInMemoryRepository() *InMemoryRepository {
	return &InMemoryRepository{
		deployments:     make(map[string]*Contract),
		deploymentsByID: make(map[int64]*Contract),
		userContracts:   make(map[string]*userContractRecord),
		nextContractID:  1,
	}
}

func deploymentKey(chainID int64, address string) string {
	return fmt.Sprintf("%d:%s", chainID, strings.ToLower(strings.TrimSpace(address)))
}

func userContractKey(userID int64, contractID int64) string {
	return fmt.Sprintf("%d:%d", userID, contractID)
}

func (r *InMemoryRepository) GetOrCreateDeployment(ctx context.Context, chainID int64, address string, startBlock int64) (*Contract, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	canonicalAddr := strings.ToLower(strings.TrimSpace(address))
	key := deploymentKey(chainID, canonicalAddr)

	if existing, found := r.deployments[key]; found {
		c := *existing
		return &c, nil
	}

	c := &Contract{
		ID:              r.nextContractID,
		ChainID:         chainID,
		Address:         canonicalAddr,
		StartBlock:      startBlock,
		IndexingEnabled: true,
		CreatedAt:       time.Now().UTC(),
	}
	r.nextContractID++

	r.deployments[key] = c
	r.deploymentsByID[c.ID] = c

	res := *c
	return &res, nil
}

func (r *InMemoryRepository) InsertTracking(ctx context.Context, userID int64, contractID int64, label string, enabled bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	key := userContractKey(userID, contractID)
	if _, exists := r.userContracts[key]; exists {
		return ErrAlreadyTracked
	}

	now := time.Now().UTC()
	r.userContracts[key] = &userContractRecord{
		UserID:     userID,
		ContractID: contractID,
		Label:      label,
		Enabled:    enabled,
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	return nil
}

func (r *InMemoryRepository) GetTracking(ctx context.Context, userID int64, contractID int64) (*TrackedContract, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	key := userContractKey(userID, contractID)
	rec, exists := r.userContracts[key]
	if !exists {
		return nil, ErrContractNotFound
	}

	dep, exists := r.deploymentsByID[contractID]
	if !exists {
		return nil, ErrContractNotFound
	}

	return &TrackedContract{
		ID:         dep.ID,
		Address:    dep.Address,
		ChainID:    dep.ChainID,
		StartBlock: dep.StartBlock,
		Label:      rec.Label,
		Enabled:    rec.Enabled,
		CreatedAt:  rec.CreatedAt,
	}, nil
}

func (r *InMemoryRepository) ListForUser(ctx context.Context, userID int64, filter ListFilter) ([]TrackedContract, int, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var matching []TrackedContract

	for _, rec := range r.userContracts {
		if rec.UserID != userID {
			continue
		}

		dep, exists := r.deploymentsByID[rec.ContractID]
		if !exists {
			continue
		}

		if filter.ChainID > 0 && dep.ChainID != filter.ChainID {
			continue
		}

		if filter.Enabled != nil && rec.Enabled != *filter.Enabled {
			continue
		}

		if strings.TrimSpace(filter.Search) != "" {
			search := strings.ToLower(strings.TrimSpace(filter.Search))
			labelMatch := strings.Contains(strings.ToLower(rec.Label), search)
			addrMatch := strings.Contains(strings.ToLower(dep.Address), search)
			if !labelMatch && !addrMatch {
				continue
			}
		}

		matching = append(matching, TrackedContract{
			ID:         dep.ID,
			Address:    dep.Address,
			ChainID:    dep.ChainID,
			StartBlock: dep.StartBlock,
			Label:      rec.Label,
			Enabled:    rec.Enabled,
			CreatedAt:  rec.CreatedAt,
		})
	}

	sort.Slice(matching, func(i, j int) bool {
		if matching[i].CreatedAt.Equal(matching[j].CreatedAt) {
			return matching[i].ID > matching[j].ID
		}
		return matching[i].CreatedAt.After(matching[j].CreatedAt)
	})

	totalItems := len(matching)

	offset := (filter.Page - 1) * filter.PageSize
	if offset < 0 {
		offset = 0
	}
	if offset >= totalItems {
		return []TrackedContract{}, totalItems, nil
	}

	end := offset + filter.PageSize
	if filter.PageSize <= 0 || end > totalItems {
		end = totalItems
	}

	return matching[offset:end], totalItems, nil
}

func (r *InMemoryRepository) UpdateTracking(ctx context.Context, userID int64, contractID int64, label *string, enabled *bool) (*TrackedContract, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	key := userContractKey(userID, contractID)
	rec, exists := r.userContracts[key]
	if !exists {
		return nil, ErrContractNotFound
	}

	dep, exists := r.deploymentsByID[contractID]
	if !exists {
		return nil, ErrContractNotFound
	}

	if label != nil {
		rec.Label = *label
	}
	if enabled != nil {
		rec.Enabled = *enabled
	}
	rec.UpdatedAt = time.Now().UTC()

	return &TrackedContract{
		ID:         dep.ID,
		Address:    dep.Address,
		ChainID:    dep.ChainID,
		StartBlock: dep.StartBlock,
		Label:      rec.Label,
		Enabled:    rec.Enabled,
		CreatedAt:  rec.CreatedAt,
	}, nil
}

func (r *InMemoryRepository) DeleteTracking(ctx context.Context, userID int64, contractID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	key := userContractKey(userID, contractID)
	if _, exists := r.userContracts[key]; !exists {
		return ErrContractNotFound
	}

	delete(r.userContracts, key)
	return nil
}
