package main

import (
	"sync"
	"testing"
	"time"
)

// fakeClock drives the limiter without sleeping.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.now = c.now.Add(d)
}

func TestTokenBucketLimiterBurstThenRefill(t *testing.T) {
	clock := newFakeClock()
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	limiter.now = clock.Now

	for i := 1; i <= globalLimitBurst; i++ {
		if allowed, retryAfter := limiter.Allow("ip:192.0.2.1"); !allowed {
			t.Fatalf("request %d denied inside the burst of %d (retryAfter %v)", i, globalLimitBurst, retryAfter)
		}
	}

	allowed, retryAfter := limiter.Allow("ip:192.0.2.1")
	if allowed {
		t.Fatalf("request %d allowed, want a denial once the burst is spent", globalLimitBurst+1)
	}
	if want := time.Second; retryAfter != want {
		t.Fatalf("retryAfter at 60 requests per minute = %v, want %v", retryAfter, want)
	}

	clock.advance(500 * time.Millisecond)
	if _, retryAfter := limiter.Allow("ip:192.0.2.1"); retryAfter != 500*time.Millisecond {
		t.Fatalf("retryAfter after 500ms = %v, want 500ms", retryAfter)
	}

	clock.advance(500 * time.Millisecond)
	if allowed, _ := limiter.Allow("ip:192.0.2.1"); !allowed {
		t.Fatal("request denied after a full second of refill, want one token restored")
	}
	if allowed, _ := limiter.Allow("ip:192.0.2.1"); allowed {
		t.Fatal("a second request was allowed from the single refilled token")
	}
}

func TestTokenBucketLimiterRefillIsCappedAtBurst(t *testing.T) {
	clock := newFakeClock()
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	limiter.now = clock.Now

	for i := 1; i <= globalLimitBurst; i++ {
		limiter.Allow("ip:192.0.2.1")
	}
	clock.advance(time.Hour)

	for i := 1; i <= globalLimitBurst; i++ {
		if allowed, _ := limiter.Allow("ip:192.0.2.1"); !allowed {
			t.Fatalf("request %d denied after an hour idle, want a full burst of %d", i, globalLimitBurst)
		}
	}
	if allowed, _ := limiter.Allow("ip:192.0.2.1"); allowed {
		t.Fatalf("bucket accumulated more than its burst of %d", globalLimitBurst)
	}
}

func TestTokenBucketLimiterKeysDoNotShareBuckets(t *testing.T) {
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)

	for i := 1; i <= globalLimitBurst; i++ {
		limiter.Allow("192.0.2.1")
	}
	if allowed, _ := limiter.Allow("192.0.2.1"); allowed {
		t.Fatal("the first address exceeded its burst, want a denial")
	}

	if allowed, retryAfter := limiter.Allow("198.51.100.1"); !allowed {
		t.Fatalf("the second address was denied at retryAfter %v because the first spent its bucket", retryAfter)
	}
	if allowed, _ := limiter.Allow("203.0.113.1"); !allowed {
		t.Fatal("the third address was denied because another address was spent")
	}
}

func TestTokenBucketLimiterSweepsKeysThatAreNeverRevisited(t *testing.T) {
	clock := newFakeClock()
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	limiter.now = clock.Now

	// One-off callers are the common case on a public API. This key is never
	// visited again, so only the sweep can remove it.
	limiter.Allow("192.0.2.1")
	if _, ok := limiter.buckets["192.0.2.1"]; !ok {
		t.Fatal("the first request did not create a bucket")
	}

	clock.advance(limiter.idleTTL + time.Minute)
	limiter.Allow("198.51.100.1")

	if _, ok := limiter.buckets["192.0.2.1"]; ok {
		t.Fatal("a key that was never revisited kept its bucket, want the sweep to delete it")
	}
	if _, ok := limiter.buckets["198.51.100.1"]; !ok {
		t.Fatal("the sweep deleted the bucket it had just created")
	}
}

func TestTokenBucketLimiterSweepKeepsBucketsInsideTheThreshold(t *testing.T) {
	clock := newFakeClock()
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	limiter.now = clock.Now

	limiter.Allow("192.0.2.1")
	kept := limiter.buckets["192.0.2.1"]

	// The sweep is due, the bucket is not idle yet.
	clock.advance(sweepInterval + time.Second)
	limiter.Allow("198.51.100.1")

	if limiter.buckets["192.0.2.1"] != kept {
		t.Fatal("the sweep replaced a bucket inside the idle threshold")
	}
}

func TestTokenBucketLimiterSweepRunsAtMostOncePerInterval(t *testing.T) {
	clock := newFakeClock()
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	limiter.now = clock.Now

	limiter.Allow("192.0.2.1")
	first := limiter.lastSweep
	if first.IsZero() {
		t.Fatal("the first request did not run a sweep")
	}

	clock.advance(sweepInterval / 2)
	limiter.Allow("198.51.100.1")
	if !limiter.lastSweep.Equal(first) {
		t.Fatalf("lastSweep moved after %v, want the interval to be %v", sweepInterval/2, sweepInterval)
	}

	clock.advance(sweepInterval / 2)
	limiter.Allow("203.0.113.1")
	if want := first.Add(sweepInterval); !limiter.lastSweep.Equal(want) {
		t.Fatalf("lastSweep = %v, want %v", limiter.lastSweep, want)
	}
}

func TestTokenBucketLimiterReplacesACrossedThresholdBucketOnAccess(t *testing.T) {
	clock := newFakeClock()
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	limiter.now = clock.Now

	limiter.Allow("192.0.2.1")
	idle := limiter.buckets["192.0.2.1"]

	clock.advance(limiter.idleTTL + time.Second)

	// The sweep has just run and left this bucket, so the per-key check is the
	// only thing that can replace it for the rest of this interval.
	limiter.lastSweep = clock.Now()
	limiter.Allow("192.0.2.1")

	if limiter.buckets["192.0.2.1"] == idle {
		t.Fatal("a bucket past the idle threshold was carried forward, want it dropped and recreated")
	}

	fresh := limiter.buckets["192.0.2.1"]
	clock.advance(time.Second)
	limiter.Allow("192.0.2.1")
	if limiter.buckets["192.0.2.1"] != fresh {
		t.Fatal("a bucket inside the idle threshold was replaced, want it reused")
	}
}

func TestTokenBucketLimiterIdleThresholdCoversAFullRefill(t *testing.T) {
	for _, tier := range []struct {
		name      string
		perMinute int
		burst     int
		want      time.Duration
	}{
		{name: "global", perMinute: globalLimitPerMinute, burst: globalLimitBurst, want: idleBucketTTL},
		{name: "auth", perMinute: authLimitPerMinute, burst: authLimitBurst, want: idleBucketTTL},
		{name: "slow tier takes the longer value", perMinute: 1, burst: 1200, want: 20 * time.Hour},
	} {
		t.Run(tier.name, func(t *testing.T) {
			if got := newTokenBucketLimiter(tier.perMinute, tier.burst).idleTTL; got != tier.want {
				t.Fatalf("idleTTL = %v, want %v", got, tier.want)
			}
		})
	}
}

func TestTokenBucketLimiterIsConcurrencySafe(t *testing.T) {
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	keys := []string{"user:1", "user:2", "ip:192.0.2.1"}

	var wg sync.WaitGroup
	for worker := 0; worker < 32; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for call := 0; call < 50; call++ {
				limiter.Allow(keys[(worker+call)%len(keys)])
			}
		}(worker)
	}
	wg.Wait()

	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	if len(limiter.buckets) != len(keys) {
		t.Fatalf("buckets = %d, want one per key (%d)", len(limiter.buckets), len(keys))
	}
	for key, bucket := range limiter.buckets {
		if bucket.tokens > limiter.burst {
			t.Fatalf("bucket %q holds %v tokens, above its burst of %v", key, bucket.tokens, limiter.burst)
		}
	}
}
