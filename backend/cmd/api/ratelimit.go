package main

import (
	"math"
	"sync"
	"time"
)

// Rate-limit tiers for W4-B4. Starting constants, not configuration; they get
// tuned when real traffic argues for different numbers.
const (
	globalLimitPerMinute = 60
	globalLimitBurst     = 10
	authLimitPerMinute   = 5
	authLimitBurst       = 2

	// idleBucketTTL is the threshold past which a bucket is stale. The
	// effective threshold is raised to one full refill when that is longer, so
	// a dropped bucket could never have held more than a fresh one does.
	idleBucketTTL = 10 * time.Minute

	// sweepInterval is how often the periodic walk of the whole map may run.
	// It is driven by the first request after the interval elapses, not by a
	// goroutine.
	sweepInterval = time.Minute
)

// tokenBucketLimiter is an in-memory token bucket store, one bucket per key. It
// refills from elapsed wall-clock time on each Allow call and starts no
// background goroutine, matching the databaseReadiness split in this package:
// httpapi declares the interface, cmd/api owns the concrete implementation.
//
// Memory is bounded by the keys seen inside the idle threshold. A key visited
// once and never again is removed by the sweep rather than left in the map.
type tokenBucketLimiter struct {
	mu         sync.Mutex
	buckets    map[string]*tokenBucket
	refillRate float64 // tokens per second
	burst      float64 // bucket capacity, also its initial fill
	idleTTL    time.Duration
	lastSweep  time.Time
	now        func() time.Time
}

type tokenBucket struct {
	tokens     float64
	lastRefill time.Time
}

func newTokenBucketLimiter(perMinute, burst int) *tokenBucketLimiter {
	refillRate := float64(perMinute) / 60
	idleTTL := idleBucketTTL
	if fullRefill := time.Duration(math.Ceil(float64(burst)/refillRate)) * time.Second; fullRefill > idleTTL {
		idleTTL = fullRefill
	}

	return &tokenBucketLimiter{
		buckets:    make(map[string]*tokenBucket),
		refillRate: refillRate,
		burst:      float64(burst),
		idleTTL:    idleTTL,
		now:        time.Now,
	}
}

// Allow consumes one token for key. It reports whether the request may proceed
// and, when it may not, how long the caller waits for one token to accumulate
// at this tier's refill rate.
func (l *tokenBucketLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.sweepIdleBuckets(now)

	bucket, exists := l.buckets[key]
	if !exists || now.Sub(bucket.lastRefill) > l.idleTTL {
		bucket = &tokenBucket{tokens: l.burst, lastRefill: now}
		l.buckets[key] = bucket
	} else {
		if elapsed := now.Sub(bucket.lastRefill).Seconds(); elapsed > 0 {
			bucket.tokens = math.Min(l.burst, bucket.tokens+elapsed*l.refillRate)
		}
		bucket.lastRefill = now
	}

	if bucket.tokens >= 1 {
		bucket.tokens--
		return true, 0
	}

	deficit := 1 - bucket.tokens
	return false, time.Duration(deficit / l.refillRate * float64(time.Second))
}

// sweepIdleBuckets walks the whole map and deletes every bucket that has not
// been touched within the idle threshold. It runs at most once per sweep
// interval, under the caller's lock, from whichever request is first after the
// interval elapses. The per-key check in Allow still covers a bucket that goes
// idle between sweeps, since the sweep interval is much shorter than the
// threshold is long.
func (l *tokenBucketLimiter) sweepIdleBuckets(now time.Time) {
	if now.Sub(l.lastSweep) < sweepInterval {
		return
	}
	l.lastSweep = now

	for key, bucket := range l.buckets {
		if now.Sub(bucket.lastRefill) > l.idleTTL {
			delete(l.buckets, key)
		}
	}
}
