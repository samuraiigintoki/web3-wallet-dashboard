# ADR 0002: Migration Runner and Execution Strategy

## Status
Accepted

## Context
In Block 7, versioned SQL migration files (`backend/migrations/0001_create_wallets.{up,down}.sql`) were introduced. We need a deterministic, reproducible mechanism to apply these migrations across local development, CI/CD, and production environments.

Two architectural forks were evaluated:
1. **Migration Asset Loading:** Runtime disk loading (`os.DirFS`) vs. Compile-time binary embedding (`go:embed`).
2. **Execution Boundary:** Automatic migration on API startup (`cmd/api`) vs. Dedicated migration CLI tool (`cmd/migrate`).

## Decisions

1. **Asset Loading via `go:embed` (Fork A):**
   - We will use Go's standard library `embed.FS` to embed `backend/migrations/*.sql` directly into the Go binary.
   - **Rationale:** Keeps the binary completely self-contained and portable, eliminating runtime filesystem dependencies and missing directory errors in containerized deployments.

2. **Dedicated `cmd/migrate` CLI Tool (Fork B):**
   - Schema migrations will be managed via a dedicated entry point (`backend/cmd/migrate/main.go`), rather than running implicitly on API startup.
   - **Rationale:** Prevents multi-replica race conditions during horizontal scaling and separates schema mutation privileges from everyday API server runtime operations.

3. **Tracking Table & Transactional Execution:**
   - A `schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)` table will record applied migrations to guarantee idempotency.
   - Migrations will execute in explicit lexical order (`0001_`, `0002_`), with each migration wrapped in a single database transaction (`BEGIN` ... `COMMIT`).
   - The runner will support explicit `up` execution for forward progress and `down` execution for local development rollbacks.

## Consequences
- The API binary remains focused solely on request serving.
- Schema migrations become a distinct, auditable pipeline step.
- An entry for `schema_migrations` is documented in `docs/database-schema.md`.