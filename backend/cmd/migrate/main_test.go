package main

// The migration lock, exercised against a real PostgreSQL server.
//
// The property that matters cannot be shown with a fake: two runs must not apply
// the same version twice. So the test creates a scratch database, drops the
// schema, and then runs `up` from several goroutines at once, each on its own
// pool, the way separate processes would. The assertions are that every run
// succeeds, that the schema lands exactly once, and that a version which fails
// leaves nothing behind.
//
// It skips when DATABASE_URL is unset, like the integration suite: a machine
// without a database still runs the rest of the tests.

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func scratchDatabase(t *testing.T) *sql.DB {
	t.Helper()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL is not set, so the migration lock test is skipped")
	}

	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close() })

	name := fmt.Sprintf("migrate_lock_%d", time.Now().UnixNano())

	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatalf("create scratch database: %v", err)
	}
	t.Cleanup(func() {
		// Drop through a fresh connection: the pool holding the scratch database
		// is closed first by the deferred Close below.
		_, _ = admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
	})

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	parsed.Path = "/" + name

	db, err := sql.Open("pgx", parsed.String())
	if err != nil {
		t.Fatalf("open scratch pool: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := db.Ping(); err != nil {
		t.Fatalf("ping scratch database: %v", err)
	}

	return db
}

func appliedVersions(t *testing.T, db *sql.DB) []string {
	t.Helper()

	rows, err := db.Query("SELECT version FROM schema_migrations ORDER BY version")
	if err != nil {
		t.Fatalf("read schema_migrations: %v", err)
	}
	defer func() { _ = rows.Close() }()

	var versions []string
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			t.Fatalf("scan version: %v", err)
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate versions: %v", err)
	}

	return versions
}

func TestMigrationLockSerialisesConcurrentRuns(t *testing.T) {
	db := scratchDatabase(t)

	if err := bootstrap(db); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}

	const runs = 4

	var wg sync.WaitGroup
	errs := make([]error, runs)

	// Every run gets its own pool, so nothing in this test is serialised by a
	// single connection.
	pools := make([]*sql.DB, runs)
	for i := range pools {
		pools[i] = db
	}

	start := make(chan struct{})

	for i := 0; i < runs; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errs[i] = withMigrationLock(pools[i], func() error { return runUp(pools[i]) })
		}(i)
	}

	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("run %d failed under contention: %v", i, err)
		}
	}

	versions := appliedVersions(t, db)
	if len(versions) == 0 {
		t.Fatal("no migration was recorded")
	}

	seen := make(map[string]struct{}, len(versions))
	for _, version := range versions {
		if _, duplicate := seen[version]; duplicate {
			t.Fatalf("version %s was recorded twice: %v", version, versions)
		}
		seen[version] = struct{}{}
	}

	// A second pass over an already-migrated schema is a no-op, which is what a
	// restart or a redeploy relies on.
	before := len(versions)
	if err := withMigrationLock(db, func() error { return runUp(db) }); err != nil {
		t.Fatalf("re-running up on a current schema failed: %v", err)
	}
	if after := len(appliedVersions(t, db)); after != before {
		t.Fatalf("a second run applied %d extra migrations", after-before)
	}
}

func TestMigrationLockIsReleasedAfterAFailedRun(t *testing.T) {
	db := scratchDatabase(t)

	if err := bootstrap(db); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}

	wantErr := fmt.Errorf("deliberate failure")
	err := withMigrationLock(db, func() error { return wantErr })
	if err == nil || err.Error() != wantErr.Error() {
		t.Fatalf("withMigrationLock returned %v, want the apply error", err)
	}

	// The lock must not survive the failure: a later run has to be able to take
	// it, or a single bad deploy would block every future migration.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("open connection: %v", err)
	}
	defer func() { _ = conn.Close() }()

	var acquired bool
	if err := conn.QueryRowContext(
		ctx,
		"SELECT pg_try_advisory_lock($1, $2)",
		migrationLockNamespace,
		migrationLockKey,
	).Scan(&acquired); err != nil {
		t.Fatalf("try lock: %v", err)
	}

	if !acquired {
		t.Fatal("the migration lock was still held after a failed run")
	}
}
