package indexer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"syscall"
	"time"
)

const (
	// retryAttempts is the total number of attempts for one range operation:
	// the initial attempt, one retry and one final retry. Nothing else in the
	// job is retried, and the bound is what keeps a failing provider from
	// turning one tick into a loop.
	retryAttempts = 3
)

// retryBackoff is the delay before each retry. The delays are fixed rather than
// exponential because the attempt count is fixed and small: 100 ms before the
// second attempt and 200 ms before the third.
var retryBackoff = []time.Duration{100 * time.Millisecond, 200 * time.Millisecond}

// waitForRetry waits for the delay or returns as soon as the context ends, so a
// shutdown or an expiring run never sits out a backoff.
func waitForRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// runWithRetry repeats one whole range operation while the failure is
// classified transient and the job context is still live. The operation is
// self-contained: callers pass a closure that reads the range and commits it,
// so a retry never resumes a partially successful attempt.
//
// It returns the failure from the final attempt unchanged, which keeps the
// message recorded on the checkpoint and logged by the worker identical to the
// message the same range would produce without retries.
func (j *Job) runWithRetry(ctx context.Context, contractID int64, operation func(context.Context) error) error {
	var failure error

	for attempt := 1; attempt <= j.attempts; attempt++ {
		if attempt > 1 {
			delay := j.retryDelay(attempt)
			j.logger.Warn("retrying the indexer range operation",
				"contractId", contractID, "attempt", attempt, "of", j.attempts,
				"delay", delay, "reason", j.wrap(failure).Error())
			if err := j.wait(ctx, delay); err != nil {
				return fmt.Errorf("waiting to retry attempt %d of %d: %w", attempt, j.attempts, err)
			}
		}

		failure = operation(ctx)
		if failure == nil {
			if attempt > 1 {
				j.logger.Info("indexer range operation succeeded after a retry",
					"contractId", contractID, "attempt", attempt, "of", j.attempts)
			}
			return nil
		}

		// The job context owns cancellation and the run deadline. Once it is
		// done, the failure is final even when its type looks retryable: an
		// attempt timeout is only worth repeating while the run has time left.
		if ctx.Err() != nil {
			return failure
		}
		if !isTransientFailure(failure) {
			return failure
		}
	}
	return failure
}

// retryDelay returns the wait before the given attempt, tolerating a policy
// with fewer delays than attempts.
func (j *Job) retryDelay(attempt int) time.Duration {
	index := attempt - 2
	if index < 0 || index >= len(j.backoff) {
		return 0
	}
	return j.backoff[index]
}

// codeError is the shape of a JSON-RPC error value: a numeric code plus a
// message. Reading the code through an interface keeps go-ethereum, which
// defines that shape, out of this package.
type codeError interface{ ErrorCode() int }

// connectionErrors are the errno values a transport failure raises when the
// connection is dropped, refused or unroutable.
var connectionErrors = [...]error{
	syscall.ECONNRESET,
	syscall.ECONNREFUSED,
	syscall.ECONNABORTED,
	syscall.EPIPE,
	syscall.ETIMEDOUT,
	syscall.EHOSTUNREACH,
	syscall.ENETUNREACH,
}

// isTransientFailure reports whether a failed range operation is a transport
// failure worth repeating.
//
// Classification is deliberately conservative: a failure that is not
// recognized here is treated as permanent, so a node that misbehaves in a new
// way cannot turn one tick into a retry loop. The recognized cases are:
//
//   - a dropped or unreachable connection: resets, refusals, broken pipes,
//     unroutable hosts, the EOF a closed connection produces, and anything
//     net.Error reports, which covers dial and read timeouts;
//   - an expired deadline, which the retry loop accepts only while the job
//     context is still live;
//   - a JSON-RPC code that means throttling or a server fault: 429, -32005
//     (the limit-exceeded code providers use) and any 5xx code;
//   - an HTTP status of 408, 429 or 5xx carried on the error value, which is
//     how go-ethereum reports a non-2xx response.
//
// Everything else is permanent, including cancellation, validation, wrong
// chain, unknown JSON-RPC errors, revert and ABI or decode failures.
func isTransientFailure(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	for _, connectionError := range connectionErrors {
		if errors.Is(err, connectionError) {
			return true
		}
	}

	var networkError net.Error
	if errors.As(err, &networkError) {
		return true
	}

	var coded codeError
	if errors.As(err, &coded) {
		return isTransientRPCCode(coded.ErrorCode())
	}
	if status, ok := httpStatus(err); ok {
		return isTransientHTTPStatus(status)
	}
	return false
}

// isTransientRPCCode reports whether a JSON-RPC error code means throttling or
// a server fault. The generic -32000 server error is not included: providers
// use it for permanent failures as well, and an unrecognized code stays
// permanent by policy.
func isTransientRPCCode(code int) bool {
	return code == 429 || code == -32005 || (code >= 500 && code <= 599)
}

// isTransientHTTPStatus reports whether an HTTP status is worth repeating.
func isTransientHTTPStatus(status int) bool {
	return status == 408 || status == 429 || (status >= 500 && status <= 599)
}

// httpStatus returns the HTTP status code carried by an error in the chain.
//
// go-ethereum reports a non-2xx JSON-RPC response as rpc.HTTPError, which
// exposes the status as a field rather than through a method, so the value is
// read structurally. Nothing here references the type: any error value with an
// integer StatusCode field in the HTTP range is understood, which keeps this
// package free of the go-ethereum dependency and testable with a local value.
func httpStatus(err error) (int, bool) {
	for current := err; current != nil; current = errors.Unwrap(current) {
		value := reflect.ValueOf(current)
		if value.Kind() == reflect.Pointer {
			if value.IsNil() {
				continue
			}
			value = value.Elem()
		}
		if value.Kind() != reflect.Struct {
			continue
		}

		field := value.FieldByName("StatusCode")
		if !field.IsValid() || !field.CanInt() {
			continue
		}
		if status := int(field.Int()); status >= 100 && status <= 599 {
			return status, true
		}
	}
	return 0, false
}
