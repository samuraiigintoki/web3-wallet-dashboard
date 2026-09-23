package contract

import (
	"context"
	"encoding/hex"
	"strings"
	"unicode/utf8"
)

// Consumer-side interface seam for chain validation
type ChainValidator interface {
	IsSupported(ctx context.Context, chainID int64) (bool, error)
}

type Service struct {
	repo           Repository
	chainValidator ChainValidator
}

func NewService(repo Repository, chainValidator ChainValidator) *Service {
	return &Service{
		repo:           repo,
		chainValidator: chainValidator,
	}
}

func isValidAddress(addr string) bool {
	if len(addr) != 42 || !strings.HasPrefix(addr, "0x") {
		return false
	}
	_, err := hex.DecodeString(addr[2:])
	return err == nil
}

func (s *Service) Create(ctx context.Context, userID int64, input CreateInput) (*TrackedContract, error) {
	normAddress := strings.ToLower(strings.TrimSpace(input.Address))
	if !isValidAddress(normAddress) {
		return nil, &ValidationError{Field: "address", Message: "must be a valid 42-character hex address starting with 0x"}
	}

	if input.StartBlock < 0 {
		return nil, &ValidationError{Field: "startBlock", Message: "start block must be non-negative"}
	}

	normLabel := strings.TrimSpace(input.Label)
	if normLabel == "" {
		return nil, &ValidationError{Field: "label", Message: "cannot be empty"}
	}
	if utf8.RuneCountInString(normLabel) > 50 {
		return nil, &ValidationError{Field: "label", Message: "must be 50 characters or less"}
	}

	if input.ChainID <= 0 {
		return nil, &ValidationError{Field: "chainId", Message: "invalid chainId"}
	}

	supported, err := s.chainValidator.IsSupported(ctx, input.ChainID)
	if err != nil {
		return nil, err
	}
	if !supported {
		return nil, &ValidationError{Field: "chainId", Message: "unsupported chain id"}
	}

	deployment, err := s.repo.GetOrCreateDeployment(ctx, input.ChainID, normAddress, input.StartBlock)
	if err != nil {
		return nil, err
	}

	err = s.repo.InsertTracking(ctx, userID, deployment.ID, normLabel, true)
	if err != nil {
		return nil, err
	}

	return s.repo.GetTracking(ctx, userID, deployment.ID)
}

func (s *Service) Get(ctx context.Context, userID int64, id int64) (*TrackedContract, error) {
	return s.repo.GetTracking(ctx, userID, id)
}

func (s *Service) List(ctx context.Context, userID int64, filter ListFilter) ([]TrackedContract, int, error) {
	if filter.Page <= 0 {
		filter.Page = 1
	}
	if filter.PageSize <= 0 {
		filter.PageSize = 20
	}

	if filter.Page > 10000 {
		return nil, 0, &ValidationError{Field: "page", Message: "page must not exceed 10000"}
	}
	if filter.PageSize > 100 {
		return nil, 0, &ValidationError{Field: "pageSize", Message: "pageSize must not exceed 100"}
	}

	if filter.ChainID < 0 {
		return nil, 0, &ValidationError{Field: "chainId", Message: "invalid chainId"}
	}

	if filter.ChainID > 0 {
		supported, err := s.chainValidator.IsSupported(ctx, filter.ChainID)
		if err != nil {
			return nil, 0, err
		}
		if !supported {
			return nil, 0, &ValidationError{Field: "chainId", Message: "unsupported chain id"}
		}
	}

	filter.Search = strings.ToLower(strings.TrimSpace(filter.Search))

	return s.repo.ListForUser(ctx, userID, filter)
}

func (s *Service) Update(ctx context.Context, userID int64, id int64, label *string, enabled *bool) (*TrackedContract, error) {
	// 1. Scoped visibility check first -> 404 precedence
	existing, err := s.repo.GetTracking(ctx, userID, id)
	if err != nil {
		return nil, err
	}

	// Wallet precedent: all-nil update is a no-op that returns current record
	if label == nil && enabled == nil {
		return existing, nil
	}

	var trimmedLabel *string
	if label != nil {
		norm := strings.TrimSpace(*label)
		if norm == "" {
			return nil, &ValidationError{Field: "label", Message: "cannot be empty"}
		}
		if utf8.RuneCountInString(norm) > 50 {
			return nil, &ValidationError{Field: "label", Message: "must be 50 characters or less"}
		}
		trimmedLabel = &norm
	}

	return s.repo.UpdateTracking(ctx, userID, id, trimmedLabel, enabled)
}

func (s *Service) Delete(ctx context.Context, userID int64, id int64) error {
	return s.repo.DeleteTracking(ctx, userID, id)
}
