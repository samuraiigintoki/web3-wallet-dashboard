package main

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
)

// sessionPurgeInterval is how often expired sessions are removed. A code
// constant, not configuration, the same treatment as the rate-limit numbers.
const sessionPurgeInterval = time.Hour

// sessionPurgeJob is the worker.Job that deletes sessions past their expiry.
// Without it every login that does not explicitly log out leaves a row behind
// forever: ValidateSession rejects an expired session but never deletes it.
type sessionPurgeJob struct {
	userSvc *user.Service
	logger  *slog.Logger
}

func (j sessionPurgeJob) Run(ctx context.Context) error {
	purged, err := j.userSvc.PurgeExpiredSessions(ctx)
	if err != nil {
		return fmt.Errorf("purge expired sessions: %w", err)
	}

	j.logger.Info("expired sessions purged", "count", purged)
	return nil
}
