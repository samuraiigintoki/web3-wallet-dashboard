package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/user"
)

// purgeStubRepo seats a controllable PurgeExpiredSessions behind the real
// service, so the adapter can be exercised without a database.
type purgeStubRepo struct {
	user.UserRepository
	purged int64
	err    error
}

func (r purgeStubRepo) PurgeExpiredSessions(context.Context) (int64, error) {
	return r.purged, r.err
}

func TestSessionPurgeJobLogsTheCountOnEveryRun(t *testing.T) {
	for _, count := range []int64{0, 7} {
		var output bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&output, nil))
		job := sessionPurgeJob{
			userSvc: user.NewService(purgeStubRepo{purged: count}),
			logger:  logger,
		}

		if err := job.Run(context.Background()); err != nil {
			t.Fatalf("Run() with count %d = %v, want nil", count, err)
		}

		var entry map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
			t.Fatalf("log output is not JSON: %v; output=%q", err, output.String())
		}
		if entry["msg"] != "expired sessions purged" || entry["level"] != "INFO" {
			t.Fatalf("log entry = %#v, want an info line about the purge", entry)
		}
		if entry["count"] != float64(count) {
			t.Fatalf("logged count = %v, want %d", entry["count"], count)
		}
	}
}

func TestSessionPurgeJobWrapsRepositoryFailure(t *testing.T) {
	cause := errors.New("database connection down")
	job := sessionPurgeJob{
		userSvc: user.NewService(purgeStubRepo{err: cause}),
		logger:  discardLogger(),
	}

	err := job.Run(context.Background())
	if !errors.Is(err, cause) {
		t.Fatalf("Run() = %v, want the repository error", err)
	}
	if !strings.Contains(err.Error(), "purge expired sessions") {
		t.Fatalf("Run() = %q, want the operation named in the error", err.Error())
	}
}
