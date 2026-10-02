// Package worker runs periodic jobs inside the API process.
//
// It exists so a second periodic job later does not mean writing ticker and
// shutdown logic again. The worker owns the tick, the per-run timeout, the
// failure log, and the stop handshake; a job only implements Run.
package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Job is one unit of periodic work. Run is called once per tick with a context
// bounded by the worker's run timeout. A returned error is logged and the next
// tick proceeds; it never stops the worker.
type Job interface {
	Run(ctx context.Context) error
}

const (
	// runTimeout bounds a single Run call. It is deliberately separate from the
	// two second readiness probe: this covers a purge that may touch many rows,
	// not a single ping.
	runTimeout = 10 * time.Second

	// stopTimeout bounds how long Stop waits for an in-flight Run to return, so
	// a stuck database cannot hang the process exit.
	stopTimeout = 10 * time.Second
)

// ErrStopTimeout reports that Stop gave up waiting for an in-flight run.
var ErrStopTimeout = errors.New("worker: stop timed out")

// ticker is the part of time.Ticker the worker needs, so tests can drive ticks
// from a channel instead of waiting on wall-clock time.
type ticker interface {
	Chan() <-chan time.Time
	Stop()
}

type systemTicker struct {
	*time.Ticker
}

func (t systemTicker) Chan() <-chan time.Time {
	return t.C
}

// Worker runs one Job on a fixed interval until it is stopped.
type Worker struct {
	job      Job
	logger   *slog.Logger
	interval time.Duration

	newTicker   func(time.Duration) ticker
	runTimeout  time.Duration
	stopTimeout time.Duration

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	started bool
	stopped bool
}

// New builds a worker. Nothing runs until Start is called.
func New(job Job, logger *slog.Logger, interval time.Duration) *Worker {
	return &Worker{
		job:         job,
		logger:      logger,
		interval:    interval,
		newTicker:   func(d time.Duration) ticker { return systemTicker{time.NewTicker(d)} },
		runTimeout:  runTimeout,
		stopTimeout: stopTimeout,
	}
}

// Start launches the tick loop. Calling it more than once has no effect.
func (w *Worker) Start() {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.started {
		return
	}
	w.started = true

	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	w.done = make(chan struct{})
	go w.loop(ctx)
}

// Stop cancels future ticks and waits for an in-flight Run to return, bounded
// by the stop timeout. It returns ErrStopTimeout when the job does not return
// in time. Calling it before Start, or twice, is a no-op.
func (w *Worker) Stop() error {
	w.mu.Lock()
	if !w.started || w.stopped {
		w.mu.Unlock()
		return nil
	}
	w.stopped = true
	cancel := w.cancel
	done := w.done
	w.mu.Unlock()

	cancel()

	select {
	case <-done:
		return nil
	case <-time.After(w.stopTimeout):
		return fmt.Errorf("%w after %s", ErrStopTimeout, w.stopTimeout)
	}
}

func (w *Worker) loop(ctx context.Context) {
	defer close(w.done)

	ticker := w.newTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.Chan():
			w.runOnce(ctx)
		}
	}
}

func (w *Worker) runOnce(ctx context.Context) {
	// A panicking job would otherwise take the process down, which is the one
	// failure mode the per-run error handling cannot cover.
	defer func() {
		if recovered := recover(); recovered != nil {
			w.logger.Error("worker job panicked", "panic", fmt.Sprint(recovered))
		}
	}()

	runCtx, cancel := context.WithTimeout(ctx, w.runTimeout)
	defer cancel()

	if err := w.job.Run(runCtx); err != nil {
		w.logger.Error("worker job failed", "error", err)
	}
}
