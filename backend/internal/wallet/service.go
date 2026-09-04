package wallet

import (
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

func (s *Service) Create(address string, chainID int, label string) (Wallet, error) {
	trimmedAddr := strings.TrimSpace(address)
	trimmedlabel := strings.TrimSpace(label)

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
			Message: "address must star with 0x",
		}
	}
	if len(trimmedAddr) != 42 {
		return Wallet{}, &ValidationError{
			Field:   "address",
			Message: "address must be of 42 characters",
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
	if len(trimmedlabel) == 0 {
		return Wallet{}, &ValidationError{
			Field:   "label",
			Message: "label must not be empty",
		}
	}
	if utf8.RuneCountInString(trimmedlabel) > 50 {
		return Wallet{}, &ValidationError{
			Field:   "label",
			Message: "label must not be greater than 50 characters",
		}
	}

	return s.repo.Create(Wallet{
		Address: trimmedAddr,
		ChainID: chainID,
		Label:   trimmedlabel,
	})

}

func (s *Service) GetByID(id string) (Wallet, error) {
	return s.repo.GetByID(id)
}
