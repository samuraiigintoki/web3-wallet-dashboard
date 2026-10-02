package worker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// fakeTicker replaces the real ticker so tests drive ticks themselves. Nothing
// here waits on wall-clock time.
type fakeTicker struct {
	ch chan time.Time
}

func newFakeTicker() *fakeTicker {
	// Buffered: a tick sent after the loop has stopped must not block the test
	// that sends it.
	return &fakeTicker{ch: make(chan time.Time, 16)}
}

func (t *fakeTicker) Chan() <-chan time.Time { return t.ch }
func (t *fakeTicker) Stop()                  {}

// testJob counts runs and signals each one, so a test can wait for a run
// without sleeping.
type testJob struct {
	mu   sync.Mutex
	runs int
	ran  chan struct{}
	run  func(ctx context.Context) error
}

func newTestJob() *testJob {
	return &testJob{ran: make(chan struct{}, 16)}
}

func (j *testJob) Run(ctx context.Context) error {
	j.mu.Lock()
	j.runs++
	run := j.run
	j.mu.Unlock()

	j.ran <- struct{}{}

	if run != nil {
		return run(ctx)
	}
	return nil
}

func (j *testJob) runCount() int {
	j.mu.Lock()
	defer j.mu.Unlock()

	return j.runs
}

func (j *testJob) waitForRun(t *testing.T) {
	t.Helper()

	select {
	case <-j.ran:
	case <-time.After(2 * time.Second):
		t.Fatal("job did not run within the guard window")
	}
}

func testWorker(job Job, tick *fakeTicker) *Worker {
	w := New(job, discardLogger(), time.Hour)
	w.newTicker = func(time.Duration) ticker { return tick }
	w.runTimeout = 100 * time.Millisecond
	w.stopTimeout = 100 * time.Millisecond
	return w
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestWorkerRunsJobOnEveryTick(t *testing.T) {
	job := newTestJob()
	tick := newFakeTicker()
	w := testWorker(job, tick)

	w.Start()
	t.Cleanup(func() { _ = w.Stop() })

	for i := 1; i <= 3; i++ {
		tick.ch <- time.Now()
		job.waitForRun(t)

		if got := job.runCount(); got != i {
			t.Fatalf("runs after tick %d = %d, want %d", i, got, i)
		}
	}
}

func TestWorkerContinuesAfterAFailingRun(t *testing.T) {
	job := newTestJob()
	failure := errors.New("database is down")
	job.run = func(context.Context) error {
		if job.runCount() == 1 {
			return failure
		}
		return nil
	}
	tick := newFakeTicker()
	w := testWorker(job, tick)

	w.Start()
	t.Cleanup(func() { _ = w.Stop() })

	tick.ch <- time.Now()
	job.waitForRun(t)
	if got := job.runCount(); got != 1 {
		t.Fatalf("runs after the failing tick = %d, want 1", got)
	}

	tick.ch <- time.Now()
	job.waitForRun(t)
	if got := job.runCount(); got != 2 {
		t.Fatalf("runs after the second tick = %d, want 2; a failed run stopped the worker", got)
	}
}

func TestWorkerSurvivesAPanickingRun(t *testing.T) {
	job := newTestJob()
	job.run = func(context.Context) error {
		if job.runCount() == 1 {
			panic("job exploded")
		}
		return nil
	}
	tick := newFakeTicker()
	w := testWorker(job, tick)

	w.Start()
	t.Cleanup(func() { _ = w.Stop() })

	tick.ch <- time.Now()
	job.waitForRun(t)

	tick.ch <- time.Now()
	job.waitForRun(t)
	if got := job.runCount(); got != 2 {
		t.Fatalf("runs after the panic = %d, want 2; the panic stopped the worker", got)
	}
}

func TestWorkerStopWaitsForTheInFlightRun(t *testing.T) {
	started := make(chan struct{})
	observedCancel := make(chan error, 1)
	job := newTestJob()
	job.run = func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		observedCancel <- ctx.Err()
		return ctx.Err()
	}
	tick := newFakeTicker()
	w := testWorker(job, tick)

	w.Start()
	tick.ch <- time.Now()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("the job never started")
	}

	if err := w.Stop(); err != nil {
		t.Fatalf("Stop() = %v, want nil once the in-flight run returns", err)
	}

	select {
	case err := <-observedCancel:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("job context error = %v, want canceled", err)
		}
	default:
		t.Fatal("Stop returned before the in-flight run observed cancellation")
	}

	select {
	case <-w.done:
	default:
		t.Fatal("the tick loop is still running after Stop returned")
	}
}

func TestWorkerStopTimesOutWhenTheRunIgnoresContext(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	job := newTestJob()
	job.run = func(context.Context) error {
		close(started)
		<-release
		return nil
	}
	tick := newFakeTicker()
	w := testWorker(job, tick)

	w.Start()
	tick.ch <- time.Now()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("the job never started")
	}

	err := w.Stop()
	if !errors.Is(err, ErrStopTimeout) {
		t.Fatalf("Stop() = %v, want ErrStopTimeout for a job that ignores its context", err)
	}

	close(release)
}

func TestWorkerStopBeforeStartAndTwiceIsANoOp(t *testing.T) {
	job := newTestJob()
	tick := newFakeTicker()

	w := testWorker(job, tick)
	if err := w.Stop(); err != nil {
		t.Fatalf("Stop() before Start = %v, want nil", err)
	}

	w.Start()
	t.Cleanup(func() { _ = w.Stop() })

	tick.ch <- time.Now()
	job.waitForRun(t)

	if err := w.Stop(); err != nil {
		t.Fatalf("first Stop() = %v, want nil", err)
	}
	if err := w.Stop(); err != nil {
		t.Fatalf("second Stop() = %v, want nil", err)
	}
}

func TestWorkerStopEndsFutureTicks(t *testing.T) {
	job := newTestJob()
	tick := newFakeTicker()
	w := testWorker(job, tick)

	w.Start()
	tick.ch <- time.Now()
	job.waitForRun(t)

	if err := w.Stop(); err != nil {
		t.Fatalf("Stop() = %v, want nil", err)
	}

	// The loop has returned, so nothing can receive this tick. The run count is
	// read after the loop goroutine exited, which the done channel orders.
	tick.ch <- time.Now()
	if got := job.runCount(); got != 1 {
		t.Fatalf("runs after Stop = %d, want 1", got)
	}
}

func TestWorkerStartIsIdempotent(t *testing.T) {
	job := newTestJob()
	tick := newFakeTicker()
	w := testWorker(job, tick)

	w.Start()
	w.Start()
	t.Cleanup(func() { _ = w.Stop() })

	tick.ch <- time.Now()
	job.waitForRun(t)

	if got := job.runCount(); got != 1 {
		t.Fatalf("runs after one tick = %d, want 1; a second Start launched a second loop", got)
	}
}
