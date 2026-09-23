package contract

import (
	"errors"
	"fmt"
)

type ValidationError struct {
	Field   string
	Message string
}

func (e ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

var (
	ErrContractNotFound = errors.New("contract not found")
	ErrAlreadyTracked   = errors.New("contract already tracked")
)
