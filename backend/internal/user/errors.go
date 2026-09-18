package user

import "errors"

var (
	ErrDuplicateEmail     = errors.New("user: email already registered")
	ErrNotFound           = errors.New("user: not found")
	ErrInvalidCredentials = errors.New("user: invalid credentials")
	ErrValidation         = errors.New("user: validation failed")
	ErrUnauthenticated    = errors.New("user: unauthenticated") //session not found error
)
