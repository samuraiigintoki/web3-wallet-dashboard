package user

import (
	"errors"
	"fmt"
)

var (
	ErrDuplicateEmail     = errors.New("user: email already registered")
	ErrNotFound           = errors.New("user: not found")
	ErrInvalidCredentials = errors.New("user: invalid credentials")
	ErrUnauthenticated    = errors.New("user: unauthenticated")
)

type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}
