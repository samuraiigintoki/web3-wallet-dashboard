package indexer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/samuraiigintoki/web3-wallet-dashboard/backend/internal/evm"
)

// timeoutError is a net.Error, the shape a provider timeout takes.
type timeoutError struct{ message string }

func (e timeoutError) Error() string   { return e.message }
func (e timeoutError) Timeout() bool   { return true }
func (e timeoutError) Temporary() bool { return true }

// jsonRPCCodeError carries a JSON-RPC error code, the shape the EVM client
// surfaces for a provider error response.
type jsonRPCCodeError struct {
	code    int
	message string
}

func (e jsonRPCCodeError) Error() string {
	return fmt.Sprintf("json-rpc error %d: %s", e.code, e.message)
}
func (e jsonRPCCodeError) ErrorCode() int { return e.code }

// httpStatusError carries an HTTP status as a field, the shape go-ethereum uses
// for a non-2xx response to a JSON-RPC call.
type httpStatusError struct {
	StatusCode int
	Status     string
}

func (e httpStatusError) Error() string { return e.Status + ": upstream body" }

func TestIsTransientFailure(t *testing.T) {
	cases := map[string]struct {
		err  error
		want bool
	}{
		"nil":                              {err: nil, want: false},
		"plain failure":                    {err: errors.New("unexpected header number 7"), want: false},
		"validation":                       {err: ValidationError{Field: "contractId", Message: "must be positive"}, want: false},
		"cancelled":                        {err: context.Canceled, want: false},
		"wrapped cancellation":             {err: fmt.Errorf("read logs for 1..2: %w", context.Canceled), want: false},
		"expired deadline":                 {err: context.DeadlineExceeded, want: true},
		"connection reset":                 {err: fmt.Errorf("read headers: %w", syscall.ECONNRESET), want: true},
		"connection refused":               {err: fmt.Errorf("dial: %w", syscall.ECONNREFUSED), want: true},
		"broken pipe":                      {err: syscall.EPIPE, want: true},
		"unreachable host":                 {err: syscall.EHOSTUNREACH, want: true},
		"dropped connection eof":           {err: io.EOF, want: true},
		"truncated body":                   {err: fmt.Errorf("read body: %w", io.ErrUnexpectedEOF), want: true},
		"network timeout":                  {err: timeoutError{message: "dial tcp: i/o timeout"}, want: true},
		"url error wrapping a timeout":     {err: &url.Error{Op: "Post", URL: "https://example.invalid", Err: timeoutError{message: "read: i/o timeout"}}, want: true},
		"network operation error":          {err: &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset by peer")}, want: true},
		"provider throttling 429":          {err: jsonRPCCodeError{code: 429, message: "too many requests"}, want: true},
		"provider limit exceeded":          {err: jsonRPCCodeError{code: -32005, message: "limit exceeded"}, want: true},
		"provider server error 503":        {err: jsonRPCCodeError{code: 503, message: "service unavailable"}, want: true},
		"provider generic server error":    {err: jsonRPCCodeError{code: -32000, message: "server error"}, want: false},
		"provider invalid params":          {err: jsonRPCCodeError{code: -32602, message: "invalid params"}, want: false},
		"provider method not found":        {err: jsonRPCCodeError{code: -32601, message: "method not found"}, want: false},
		"http 502":                         {err: httpStatusError{StatusCode: 502, Status: "502 Bad Gateway"}, want: true},
		"http 504":                         {err: httpStatusError{StatusCode: 504, Status: "504 Gateway Timeout"}, want: true},
		"http 429":                         {err: httpStatusError{StatusCode: 429, Status: "429 Too Many Requests"}, want: true},
		"http 408":                         {err: httpStatusError{StatusCode: 408, Status: "408 Request Timeout"}, want: true},
		"http 404":                         {err: httpStatusError{StatusCode: 404, Status: "404 Not Found"}, want: false},
		"http 401":                         {err: httpStatusError{StatusCode: 401, Status: "401 Unauthorized"}, want: false},
		"wrapped http 500":                 {err: fmt.Errorf("read logs for 1..2: %w", httpStatusError{StatusCode: 500, Status: "500 Internal Server Error"}), want: true},
		"block not found":                  {err: fmt.Errorf("read headers: %w", evm.ErrBlockNotFound), want: false},
		"decode failure":                   {err: errors.New("decode log 0 at block 7: unsupported event topic"), want: false},
		"canceled run wrapped by a status": {err: fmt.Errorf("mark contract 1 running: %w", ErrCheckpointNotFound), want: false},
		"deadline from an attempt context": {err: fmt.Errorf("read headers for 1..2: %w", context.DeadlineExceeded), want: true},
		"status field out of range":        {err: zeroStatusError{}, want: false},
	}

	for name, tt := range cases {
		t.Run(name, func(t *testing.T) {
			if got := isTransientFailure(tt.err); got != tt.want {
				t.Errorf("isTransientFailure(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

func TestIsTransientFailureNilStatusError(t *testing.T) {
	// A nil pointer with the HTTPError shape must not panic or be classified.
	var typedNil *httpStatusPointerError
	if isTransientFailure(typedNil) {
		t.Error("a nil typed error must not be transient")
	}
}

// zeroStatusError carries a StatusCode field outside the HTTP range, which the
// structural read must not accept.
type zeroStatusError struct{ StatusCode int }

func (e zeroStatusError) Error() string { return "status 0" }

// httpStatusPointerError mirrors an error type that carries its status on a
// pointer, which the structural read must skip when the pointer is nil.
type httpStatusPointerError struct{ StatusCode int }

func (e *httpStatusPointerError) Error() string { return "pointer status error" }

func TestNewJobRetryDefaults(t *testing.T) {
	job := newScannerJob(t, newScannerRepository(), &scannerReader{}, nil)

	if job.attempts != 3 {
		t.Errorf("attempts = %d, want 3", job.attempts)
	}
	if len(job.backoff) != 2 || job.backoff[0] != 100*time.Millisecond || job.backoff[1] != 200*time.Millisecond {
		t.Errorf("backoff = %v, want 100ms then 200ms", job.backoff)
	}
	if job.wait == nil {
		t.Error("wait seam is nil, want the context-aware default")
	}
}

// flakyReader fails a scripted number of leading calls per method and then
// serves the wrapped reader.
type flakyReader struct {
	*scannerReader

	headerFailures map[int]error
	logFailures    map[int]error
	headerCalls    int
	logCalls       int
}

func (r *flakyReader) BlockHeaders(ctx context.Context, blockNumbers []uint64) ([]evm.BlockHeader, error) {
	call := r.headerCalls
	r.headerCalls++
	if err, ok := r.headerFailures[call]; ok {
		return nil, err
	}
	return r.scannerReader.BlockHeaders(ctx, blockNumbers)
}

func (r *flakyReader) FilterLogs(ctx context.Context, filter evm.LogFilter) ([]evm.RawLog, error) {
	call := r.logCalls
	r.logCalls++
	if err, ok := r.logFailures[call]; ok {
		return nil, err
	}
	return r.scannerReader.FilterLogs(ctx, filter)
}

// recordingWaits replaces the wall-clock backoff with a recorder.
type recordingWaits struct {
	delays  []time.Duration
	cancel  context.CancelFunc
	failure error
}

func (w *recordingWaits) wait(ctx context.Context, delay time.Duration) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	w.delays = append(w.delays, delay)
	if w.cancel != nil {
		// Cancelling inside the wait is what a shutdown during a backoff looks
		// like, so the seam reports it the way the real wait would.
		w.cancel()
		return ctx.Err()
	}
	if w.failure != nil {
		return w.failure
	}
	return nil
}

func TestJobRetriesTransientRangeRead(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	reader := &flakyReader{
		scannerReader: &scannerReader{latestBlock: 1000},
		logFailures:   map[int]error{0: timeoutError{message: "Post https://provider.example: read: i/o timeout"}},
	}
	job := newScannerJob(t, repo, reader, nil)
	waits := &recordingWaits{}
	job.wait = waits.wait

	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil after the retry", err)
	}

	if reader.logCalls != 2 {
		t.Errorf("log reads = %d, want the failed attempt and one retry", reader.logCalls)
	}
	if reader.headerCalls != 2 {
		t.Errorf("header batch requests = %d, want the whole range re-issued", reader.headerCalls)
	}
	if len(waits.delays) != 1 || waits.delays[0] != 100*time.Millisecond {
		t.Errorf("waits = %v, want one 100ms wait", waits.delays)
	}
	if len(repo.commits) != 1 {
		t.Fatalf("commits = %d, want exactly one after the retry succeeded", len(repo.commits))
	}
	if repo.commits[0].FromBlock != 0 || repo.commits[0].ToBlock != 99 {
		t.Errorf("committed range = %d..%d, want 0..99", repo.commits[0].FromBlock, repo.commits[0].ToBlock)
	}
	// Nothing is written between attempts: the running status is recorded once,
	// before the first attempt, and no failure status is recorded at all.
	assertStatusSequence(t, repo, []statusCall{{contractID: 1, status: StatusRunning}})
}

func TestJobRetryScheduleAndFinalFailure(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	reader := &flakyReader{
		scannerReader:  &scannerReader{latestBlock: 1000},
		headerFailures: map[int]error{0: syscall.ECONNRESET, 1: syscall.ECONNRESET, 2: syscall.ECONNRESET},
	}
	job := newScannerJob(t, repo, reader, nil)
	waits := &recordingWaits{}
	job.wait = waits.wait

	err := job.Run(t.Context())
	if err == nil {
		t.Fatal("Run() = nil, want the final failure")
	}
	if !errors.Is(err, syscall.ECONNRESET) {
		t.Errorf("error %v does not wrap the connection failure", err)
	}
	if reader.headerCalls != 3 {
		t.Errorf("header batch requests = %d, want exactly three attempts", reader.headerCalls)
	}
	if len(waits.delays) != 2 || waits.delays[0] != 100*time.Millisecond || waits.delays[1] != 200*time.Millisecond {
		t.Errorf("waits = %v, want 100ms then 200ms", waits.delays)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %d, want none after three failed attempts", len(repo.commits))
	}
	if repo.checkpoints[1].NextBlock != 0 {
		t.Errorf("next block = %d, want it untouched", repo.checkpoints[1].NextBlock)
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobDoesNotRetryPermanentFailure(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	// An unsupported topic is a decode failure: the endpoint answered, so
	// repeating the read cannot help.
	unsupported := scannerTestLog(0, "0x"+strings.Repeat("33", 32), scannerAddressTopic(scannerTestOwner))
	unsupported.LogIndex = 0

	reader := &flakyReader{scannerReader: &scannerReader{latestBlock: 1000, logs: []evm.RawLog{unsupported}}}
	job := newScannerJob(t, repo, reader, nil)
	waits := &recordingWaits{}
	job.wait = waits.wait

	if err := job.Run(t.Context()); err == nil {
		t.Fatal("Run() = nil, want the decode failure")
	}
	if reader.logCalls != 1 {
		t.Errorf("log reads = %d, want a single attempt for a permanent failure", reader.logCalls)
	}
	if len(waits.delays) != 0 {
		t.Errorf("waits = %v, want none for a permanent failure", waits.delays)
	}
	assertLastStatus(t, repo, StatusError)
}

func TestJobDoesNotRetryCancellation(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	reader := &flakyReader{
		scannerReader: &scannerReader{latestBlock: 1000, logsErr: context.Canceled},
	}
	job := newScannerJob(t, repo, reader, nil)
	waits := &recordingWaits{}
	job.wait = waits.wait

	err := job.Run(t.Context())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() = %v, want the cancellation", err)
	}
	if reader.logCalls != 1 {
		t.Errorf("log reads = %d, want one attempt", reader.logCalls)
	}
	if len(waits.delays) != 0 {
		t.Errorf("waits = %v, want none for cancellation", waits.delays)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %d, want none", len(repo.commits))
	}
}

// endRunOnRead cancels the run context and returns a retryable failure, which
// is what an attempt timeout that consumed the rest of the run looks like.
type endRunOnRead struct {
	*scannerReader
	cancel context.CancelFunc
	err    error
	calls  int
}

func (r *endRunOnRead) BlockHeaders(ctx context.Context, blockNumbers []uint64) ([]evm.BlockHeader, error) {
	r.calls++
	if r.cancel != nil {
		r.cancel()
	}
	return nil, r.err
}

func TestJobRetriesAnAttemptTimeoutOnlyWhileTheRunIsLive(t *testing.T) {
	live := newScannerRepository()
	scannerTestDeployment(live, 1, 0, scannerTestAddress, scannerChainID, true)

	expiring := &endRunOnRead{
		scannerReader: &scannerReader{latestBlock: 1000},
		err:           fmt.Errorf("read headers for 0..99: %w", context.DeadlineExceeded),
	}
	job := newScannerJob(t, live, expiring, nil)
	waits := &recordingWaits{}
	job.wait = waits.wait

	// The run context is still live, so the expired attempt deadline is worth
	// repeating even though the reader keeps failing this way.
	if err := job.Run(t.Context()); err == nil {
		t.Fatal("Run() = nil, want the failure after every attempt")
	}
	if expiring.calls != 3 {
		t.Errorf("attempts = %d, want three while the run context is live", expiring.calls)
	}
	if len(waits.delays) != 2 {
		t.Errorf("waits = %v, want both backoffs", waits.delays)
	}

	// The same failure once the run context is done is final: the run has no
	// time left to retry with.
	done := newScannerRepository()
	scannerTestDeployment(done, 1, 0, scannerTestAddress, scannerChainID, true)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := &endRunOnRead{
		scannerReader: &scannerReader{latestBlock: 1000},
		cancel:        cancel,
		err:           fmt.Errorf("read headers for 0..99: %w", context.DeadlineExceeded),
	}
	retrying := newScannerJob(t, done, finished, nil)
	waits = &recordingWaits{}
	retrying.wait = waits.wait

	if err := retrying.Run(ctx); err == nil {
		t.Fatal("Run() = nil, want the failure")
	}
	if finished.calls != 1 {
		t.Errorf("attempts = %d, want one once the run context is done", finished.calls)
	}
	if len(waits.delays) != 0 {
		t.Errorf("waits = %v, want none once the run context is done", waits.delays)
	}
}

func TestJobCancellationDuringBackoffEndsTheRun(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	reader := &flakyReader{
		scannerReader:  &scannerReader{latestBlock: 1000},
		headerFailures: map[int]error{0: syscall.ECONNRESET, 1: syscall.ECONNRESET},
	}
	job := newScannerJob(t, repo, reader, nil)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	waits := &recordingWaits{cancel: cancel}
	job.wait = waits.wait

	err := job.Run(ctx)
	if err == nil {
		t.Fatal("Run() = nil, want the interrupted wait")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error %v does not wrap the cancellation", err)
	}
	if reader.headerCalls != 1 {
		t.Errorf("attempts = %d, want no second attempt after the wait was cancelled", reader.headerCalls)
	}
	if len(waits.delays) != 1 {
		t.Errorf("waits = %v, want one wait that was interrupted", waits.delays)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %d, want none", len(repo.commits))
	}
	assertLastStatus(t, repo, StatusError)
}

// commitFlakeRepository fails the first commit with a scripted error so the
// retry covers the commit as part of the whole range operation.
type commitFlakeRepository struct {
	*scannerRepository
	failures []error
	calls    int
}

func (r *commitFlakeRepository) CommitRange(ctx context.Context, commit RangeCommit) (*Checkpoint, error) {
	call := r.calls
	r.calls++
	if call < len(r.failures) && r.failures[call] != nil {
		return nil, r.failures[call]
	}
	return r.scannerRepository.CommitRange(ctx, commit)
}

func TestJobRetriesTransientCommitFailure(t *testing.T) {
	base := newScannerRepository()
	scannerTestDeployment(base, 1, 0, scannerTestAddress, scannerChainID, true)
	repo := &commitFlakeRepository{
		scannerRepository: base,
		failures:          []error{fmt.Errorf("commit range 0..99: %w", syscall.ECONNRESET)},
	}

	reader := &flakyReader{scannerReader: &scannerReader{latestBlock: 1000}}
	job := newScannerJob(t, repo, reader, nil)
	waits := &recordingWaits{}
	job.wait = waits.wait

	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil after the commit was retried", err)
	}
	if repo.calls != 2 {
		t.Errorf("commit attempts = %d, want the failed commit and the retry", repo.calls)
	}
	if reader.headerCalls != 2 || reader.logCalls != 2 {
		t.Errorf("reads = %d header batches and %d log reads, want the whole operation repeated", reader.headerCalls, reader.logCalls)
	}
	if len(base.commits) != 1 {
		t.Fatalf("commits = %d, want exactly one stored", len(base.commits))
	}
	if len(waits.delays) != 1 || waits.delays[0] != 100*time.Millisecond {
		t.Errorf("waits = %v, want one 100ms wait", waits.delays)
	}
	assertStatusSequence(t, base, []statusCall{{contractID: 1, status: StatusRunning}})
}

func TestJobRetryKeepsTheCheckpointOnFailure(t *testing.T) {
	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)
	repo.commitErr = fmt.Errorf("commit range 0..99: %w", syscall.ECONNRESET)

	reader := &flakyReader{scannerReader: &scannerReader{latestBlock: 1000}}
	job := newScannerJob(t, repo, reader, nil)
	job.wait = (&recordingWaits{}).wait

	if err := job.Run(t.Context()); err == nil {
		t.Fatal("Run() = nil, want the commit failure")
	}
	if repo.checkpoints[1].NextBlock != 0 {
		t.Errorf("next block = %d, want it untouched after the retried commit failed", repo.checkpoints[1].NextBlock)
	}
	if len(repo.commits) != 0 {
		t.Errorf("commits = %d, want none", len(repo.commits))
	}
	assertStatusSequence(t, repo, []statusCall{
		{contractID: 1, status: StatusRunning},
		{contractID: 1, status: StatusError},
	})
}

func TestJobRetryReasonIsSanitized(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))

	repo := newScannerRepository()
	scannerTestDeployment(repo, 1, 0, scannerTestAddress, scannerChainID, true)

	// The failure carries the endpoint URL in its message, as a transport error
	// from a provider does, and is retryable.
	transport := func() error {
		return &url.Error{Op: "Post", URL: scannerRPCURL, Err: timeoutError{message: "read: i/o timeout"}}
	}
	reader := &flakyReader{
		scannerReader:  &scannerReader{latestBlock: 1000},
		headerFailures: map[int]error{0: transport(), 1: transport()},
	}
	job, err := NewJob(repo, reader, scannerChainID, scannerRPCURL, logger)
	if err != nil {
		t.Fatalf("NewJob() = %v, want nil", err)
	}
	job.wait = (&recordingWaits{}).wait

	if err := job.Run(t.Context()); err != nil {
		t.Fatalf("Run() = %v, want nil after the retry", err)
	}

	records := logs.String()
	if !strings.Contains(records, "retrying the indexer range operation") {
		t.Errorf("the retry was not logged: %s", records)
	}
	if strings.Contains(records, "scanner-unit-secret") {
		t.Errorf("the retry reason leaked the RPC credential: %s", records)
	}
}

func TestRetryWaitHonoursAnExpiredContext(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	started := time.Now()
	if err := waitForRetry(ctx, 5*time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("waitForRetry() = %v, want the cancellation", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Errorf("waitForRetry returned after %s, want it to return at once", elapsed)
	}

	if err := waitForRetry(t.Context(), 0); err != nil {
		t.Errorf("waitForRetry(zero delay) = %v, want nil", err)
	}
	if err := waitForRetry(t.Context(), time.Millisecond); err != nil {
		t.Errorf("waitForRetry(1ms) = %v, want nil", err)
	}
}
