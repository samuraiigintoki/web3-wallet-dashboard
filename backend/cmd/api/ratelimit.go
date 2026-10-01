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

	// idleBucketTTL is the lazy-eviction threshold. A bucket untouched for
	// longer than this is dropped and recreated full on its next access. The
	// effective threshold is raised to one full refill when that is longer, so
	// an evicted bucket could never have held more than a fresh one does.
	idleBucketTTL = 10 * time.Minute
)

// tokenBucketLimiter is an in-memory token bucket store, one bucket per key.
// It refills from elapsed wall-clock time on each Allow call and starts no
// background goroutine, matching the databaseReadiness split in this package:
// httpapi declares the interface, cmd/api owns the concrete implementation.
//
// Memory is bounded by the number of distinct keys seen, not by time. Dropping
// a bucket on access bounds how stale a bucket may be, not how many exist; a
// real sweep is W4-B5's job, where a background worker already exists.
type tokenBucketLimiter struct {
	mu         sync.Mutex
	buckets    map[string]*tokenBucket
	refillRate float64 // tokens per second
	burst      float64 // bucket capacity, also its initial fill
	idleTTL    time.Duration
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

// Allow consumes one token for key. It reports whether the request may
// proceed and, when it may not, how long the caller waits for one token to
// accumulate at this tier's refill rate.
func (l *tokenBucketLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
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
