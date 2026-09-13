package wallet

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf8"
)

type Service struct {
	repo WalletRepository
}

func NewService(repo WalletRepository) *Service {
	return &Service{
		repo: repo,
	}
}

type ValidationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%q: %q", e.Field, e.Message)
}

func (s *Service) Create(ctx context.Context, address string, chainID int64, label string) (Wallet, error) {
	trimmedAddr := strings.ToLower(strings.TrimSpace(address))

	// address validations
	if len(trimmedAddr) <= 0 {
		return Wallet{}, &ValidationError{
			Field:   "address",
			Message: "address must not be empty",
		}
	}
	if !strings.HasPrefix(trimmedAddr, "0x") {
		return Wallet{}, &ValidationError{
			Field:   "address",
			Message: "address must start with 0x",
		}
	}
	if len(trimmedAddr) != 42 {
		return Wallet{}, &ValidationError{
			Field:   "address",
			Message: "address must be of 42 characters",
		}
	}
	if _, err := hex.DecodeString(trimmedAddr[2:]); err != nil {
		return Wallet{}, &ValidationError{
			Field:   "address",
			Message: "address must be a hexadecimal string",
		}
	}

	// chainID validations
	if chainID <= 0 {
		return Wallet{}, &ValidationError{
			Field:   "chainId",
			Message: "invalid chainId",
		}
	}

	// label validations
	trimmedLabel, err := validateLabel(label)
	if err != nil {
		return Wallet{}, err
	}

	return s.repo.Create(ctx, Wallet{
		Address: trimmedAddr,
		ChainID: chainID,
		Label:   trimmedLabel,
	})

}

func (s *Service) GetByID(ctx context.Context, id int64) (Wallet, error) {
	return s.repo.GetByID(ctx, id)
}

func (s *Service) List(ctx context.Context, filter WalletFilter) ([]Wallet, int64, error) {

	filter.Search = strings.ToLower(strings.TrimSpace(filter.Search))

	if filter.Page <= 0 {
		filter.Page = 1
	} else if filter.Page > 10000 {
		return nil, 0, &ValidationError{
			Field:   "page",
			Message: "page cannot exceed 10000",
		}
	}

	if filter.PageSize <= 0 {
		filter.PageSize = 20
	} else if filter.PageSize > 100 {
		return nil, 0, &ValidationError{
			Field:   "pageSize",
			Message: "pageSize cannot exceed 100",
		}
	}

	if filter.ChainID < 0 {
		return nil, 0, &ValidationError{
			Field:   "chainId",
			Message: "invalid chainId",
		}
	}

	return s.repo.List(ctx, filter)
}

func (s *Service) UpdateLabel(ctx context.Context, id int64, label *string) (Wallet, error) {

	if label == nil {
		return s.GetByID(ctx, id)
	}

	rawLabel := *label

	validatedLabel, err := validateLabel(rawLabel)
	if err != nil {
		return Wallet{}, err
	}

	return s.repo.Update(ctx, id, validatedLabel)
}

func (s *Service) Delete(ctx context.Context, id int64) error {
	return s.repo.Delete(ctx, id)
}

// /// Helper Validation Function
func validateLabel(label string) (string, error) {

	trimmedLabel := strings.TrimSpace(label)

	if len(trimmedLabel) == 0 {
		return "", &ValidationError{
			Field:   "label",
			Message: "label must not be empty",
		}
	}

	if utf8.RuneCountInString(trimmedLabel) > 50 {
		return "", &ValidationError{
			Field:   "label",
			Message: "label must not be greater than 50 characters",
		}
	}

	return trimmedLabel, nil
}
