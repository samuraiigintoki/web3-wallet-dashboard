package chain

import (
	"context"
	"errors"
)

type Service struct {
	repo Repository
}

func NewService(repo Repository) *Service {
	return &Service{
		repo: repo,
	}
}

func (s *Service) List(ctx context.Context) ([]Chain, error) {
	return s.repo.ListEnabled(ctx)
}

func (s *Service) IsSupported(ctx context.Context, id int64) (bool, error) {
	c, err := s.repo.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return false, nil
		}
		return false, err
	}

	return c.Enabled, nil
}
