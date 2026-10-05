package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/indexer"
)

// wiringRepository stands in for the indexer repository. Only the startup
// reset is reachable from the wiring, so the embedded interface is left nil on
// purpose: any other call panics and the test fails loudly.
type wiringRepository struct {
	indexer.Repository

	resetCalls int
	resetCount int64
	resetErr   error
}

func (r *wiringRepository) ResetRunningCheckpoints(context.Context) (int64, error) {
	r.resetCalls++
	return r.resetCount, r.resetErr
}

// recordCollector keeps every log record so a test can assert on level,
// message and count instead of matching text.
type recordCollector struct {
	mu      sync.Mutex
	records []slog.Record
}

func (c *recordCollector) Enabled(context.Context, slog.Level) bool { return true }

func (c *recordCollector) Handle(_ context.Context, record slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = append(c.records, record.Clone())
	return nil
}

func (c *recordCollector) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *recordCollector) WithGroup(string) slog.Handler      { return c }

// text renders every record, message and attribute, so a test can assert that
// nothing sensitive reached the log at all.
func (c *recordCollector) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()

	var out strings.Builder
	for _, record := range c.records {
		out.WriteString(record.Message)
		out.WriteString(" ")
		record.Attrs(func(attr slog.Attr) bool {
			out.WriteString(attr.String())
			out.WriteString(" ")
			return true
		})
		out.WriteString("\n")
	}
	return out.String()
}

func (c *recordCollector) atLevel(level slog.Level) []slog.Record {
	c.mu.Lock()
	defer c.mu.Unlock()

	var matched []slog.Record
	for _, record := range c.records {
		if record.Level == level {
			matched = append(matched, record)
		}
	}
	return matched
}

// newChainIDServer answers the only RPC call startup makes, eth_chainId, with
// the given hex value.
func newChainIDServer(t *testing.T, chainIDHex string) *httptest.Server {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read RPC request: %v", err)
			return
		}
		if !bytes.Contains(body, []byte("eth_chainId")) {
			t.Errorf("unexpected RPC request during startup: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":"`+chainIDHex+`"}`)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestStartIndexerDisabledWithoutRPCURL(t *testing.T) {
	t.Setenv("EVM_RPC_URL", "")

	repo := &wiringRepository{}
	logs := &recordCollector{}

	indexing, err := startIndexer(t.Context(), repo, slog.New(logs))
	if err != nil {
		t.Fatalf("startIndexer() = %v, want nil: an unset endpoint disables indexing, it does not fail startup", err)
	}
	if indexing != nil {
		t.Fatal("startIndexer() returned a worker, want none while indexing is disabled")
	}
	if repo.resetCalls != 0 {
		t.Errorf("reset calls = %d, want none without an endpoint", repo.resetCalls)
	}
	if err := indexing.Stop(); err != nil {
		t.Errorf("Stop() on the disabled indexer = %v, want nil", err)
	}

	warnings := logs.atLevel(slog.LevelWarn)
	if len(warnings) != 1 {
		t.Fatalf("warnings = %d, want exactly one startup warning", len(warnings))
	}
	message := warnings[0].Message
	if !strings.Contains(message, "EVM_RPC_URL") || !strings.Contains(message, "disabled") {
		t.Errorf("warning %q does not name indexing as disabled", message)
	}
}

func TestStartIndexerRejectsAnotherChain(t *testing.T) {
	server := newChainIDServer(t, "0x1")

	t.Setenv("EVM_RPC_URL", server.URL)
	repo := &wiringRepository{}
	logs := &recordCollector{}

	indexing, err := startIndexer(t.Context(), repo, slog.New(logs))
	if err == nil {
		t.Fatal("startIndexer() = nil, want a chain mismatch failure")
	}
	if indexing != nil {
		t.Fatal("startIndexer() returned a worker for an endpoint on another chain")
	}
	if !strings.Contains(err.Error(), "unusable") {
		t.Errorf("error %q does not report an unusable endpoint", err)
	}
	if !strings.Contains(err.Error(), "chain ID mismatch") {
		t.Errorf("error %q does not name the cause", err)
	}
	if repo.resetCalls != 0 {
		t.Errorf("reset calls = %d, want none before the endpoint is trusted", repo.resetCalls)
	}
}

func TestStartIndexerRejectsUnreachableEndpoint(t *testing.T) {
	// Port 1 on loopback refuses immediately, which is the shape of an
	// endpoint that is not running. The path segment is the credential a real
	// provider URL carries, and it must not reach a log line or an error.
	const credential = "unit-wiring-secret"
	t.Setenv("EVM_RPC_URL", "http://127.0.0.1:1/v2/"+credential)

	repo := &wiringRepository{}
	logs := &recordCollector{}

	indexing, err := startIndexer(t.Context(), repo, slog.New(logs))
	if err == nil {
		t.Fatal("startIndexer() = nil, want an unreachable endpoint failure")
	}
	if indexing != nil {
		t.Fatal("startIndexer() returned a worker for an unreachable endpoint")
	}
	if repo.resetCalls != 0 {
		t.Errorf("reset calls = %d, want none before the endpoint is trusted", repo.resetCalls)
	}
	if strings.Contains(err.Error(), credential) {
		t.Errorf("credential leaked into the startup error: %q", err)
	}
	if strings.Contains(logs.text(), credential) {
		t.Errorf("credential leaked into the log: %q", logs.text())
	}
}

func TestStartIndexerRejectsEndpointThatNeverAnswers(t *testing.T) {
	never := make(chan struct{})
	t.Cleanup(func() { close(never) })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-never:
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("EVM_RPC_URL", server.URL)

	// A short caller deadline stands in for the startup timeout: an endpoint
	// that accepts the connection and then says nothing must not hold startup
	// open.
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()

	repo := &wiringRepository{}
	indexing, err := startIndexer(ctx, repo, slog.New(&recordCollector{}))
	if err == nil {
		t.Fatal("startIndexer() = nil, want a failure for an endpoint that never answers")
	}
	if indexing != nil {
		t.Fatal("startIndexer() returned a worker for an endpoint that never answered")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error %v does not wrap the deadline", err)
	}
	if repo.resetCalls != 0 {
		t.Errorf("reset calls = %d, want none before the endpoint is trusted", repo.resetCalls)
	}
}

func TestStartIndexerFailsWhenTheStartupResetFails(t *testing.T) {
	server := newChainIDServer(t, "0xaa36a7")

	t.Setenv("EVM_RPC_URL", server.URL)
	repo := &wiringRepository{resetErr: errors.New("database is not available")}

	indexing, err := startIndexer(t.Context(), repo, slog.New(&recordCollector{}))
	if err == nil {
		t.Fatal("startIndexer() = nil, want the reset failure")
	}
	if indexing != nil {
		t.Fatal("startIndexer() returned a worker after a failed startup reset")
	}
	if !strings.Contains(err.Error(), "reset stale indexer checkpoints") {
		t.Errorf("error %q does not name the failed step", err)
	}
	if repo.resetCalls != 1 {
		t.Errorf("reset calls = %d, want 1", repo.resetCalls)
	}
}

func TestStartIndexerStartsAndStops(t *testing.T) {
	server := newChainIDServer(t, "0xaa36a7")

	t.Setenv("EVM_RPC_URL", server.URL)
	repo := &wiringRepository{resetCount: 2}
	logs := &recordCollector{}

	indexing, err := startIndexer(t.Context(), repo, slog.New(logs))
	if err != nil {
		t.Fatalf("startIndexer() = %v, want nil", err)
	}
	if indexing == nil {
		t.Fatal("startIndexer() returned no worker for a verified endpoint")
	}
	if repo.resetCalls != 1 {
		t.Errorf("reset calls = %d, want exactly one at startup", repo.resetCalls)
	}

	started := logs.atLevel(slog.LevelInfo)
	var foundReset, foundStarted bool
	for _, record := range started {
		if strings.Contains(record.Message, "checkpoints reset") {
			foundReset = true
		}
		if strings.Contains(record.Message, "contract indexer started") {
			foundStarted = true
		}
	}
	if !foundReset {
		t.Errorf("startup did not report the reset it performed: %v", started)
	}
	if !foundStarted {
		t.Errorf("startup did not report the running indexer: %v", started)
	}
	if warnings := logs.atLevel(slog.LevelWarn); len(warnings) != 0 {
		t.Errorf("warnings = %v, want none with a verified endpoint", warnings)
	}

	if err := indexing.Stop(); err != nil {
		t.Errorf("Stop() = %v, want nil", err)
	}
}
