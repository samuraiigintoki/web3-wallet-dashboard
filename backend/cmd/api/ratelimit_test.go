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
		limiter.Allow("user:1")
	}
	if allowed, _ := limiter.Allow("user:1"); allowed {
		t.Fatal("user 1 exceeded its burst, want a denial")
	}

	if allowed, retryAfter := limiter.Allow("user:2"); !allowed {
		t.Fatalf("user 2 denied at retryAfter %v because user 1 spent the bucket", retryAfter)
	}
	if allowed, _ := limiter.Allow("ip:192.0.2.1"); !allowed {
		t.Fatal("the address bucket denied a request because a user bucket was spent")
	}
}

func TestTokenBucketLimiterEvictsIdleBucketsOnAccess(t *testing.T) {
	clock := newFakeClock()
	limiter := newTokenBucketLimiter(globalLimitPerMinute, globalLimitBurst)
	limiter.now = clock.Now

	limiter.Allow("ip:stale")
	stale := limiter.buckets["ip:stale"]

	clock.advance(limiter.idleTTL + time.Second)
	limiter.Allow("ip:fresh")
	fresh := limiter.buckets["ip:fresh"]

	limiter.Allow("ip:stale")
	if limiter.buckets["ip:stale"] == stale {
		t.Fatal("a bucket older than the idle threshold was carried forward, want it dropped and recreated")
	}
	if limiter.buckets["ip:fresh"] != fresh {
		t.Fatal("touching one key replaced an unrelated key's bucket")
	}

	clock.advance(time.Second)
	limiter.Allow("ip:fresh")
	if limiter.buckets["ip:fresh"] != fresh {
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
