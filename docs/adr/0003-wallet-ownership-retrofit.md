# ADR 0003: Wallet Ownership Retrofit

## Status
Accepted

## Context
Migration 0001 created `wallets` for the unauthenticated vertical slice: no owner column, and `CONSTRAINT unique_address_chain UNIQUE (address, chain_id)` making an address single tenant across the whole database. All five wallet routes were public, and the API document carried an explicit accepted risk that any caller could PATCH or DELETE any wallet by id.

Migration 0006 is the schema half of the B6 retrofit and is the approved baseline for this branch. This ADR records the policy behind it, plus the repository, service and handler behavior that depends on it.

The contract slice already carries ownership (`user_contracts.user_id`, `ON DELETE CASCADE`), so wallets were the last user-scoped table without an owner.

## Decisions

1. **Purge, do not fabricate ownership.** `0006` runs `DELETE FROM wallets` before adding the column. The existing rows are pre-auth development artifacts with no trustworthy row-to-user mapping, and no production deployment exists, so there is nothing to migrate. Inventing an owner would be worse than deleting: the rows are address records only, and a wrong owner is a silent security statement.

2. **`wallets.user_id` is `BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE`.** The column is added NOT NULL with no default, which is why the purge is mandatory rather than optional: PostgreSQL rejects the `ALTER` on a table that still holds rows (23502). Type and identity match `users.id` (`BIGSERIAL`).

3. **The unique moves to `uq_wallets_user_chain_address UNIQUE (user_id, chain_id, address)`.** Two users may save the same address on the same chain; one user may not save it twice. The postgres repository's 23505 branch is re-pointed from `unique_address_chain` to this name, and the in-memory repository scopes its duplicate scan to the given user so both backends answer `ErrWalletDuplicate` identically. `wallet/parity_test.go` holds that equivalence.

4. **The index moves with the query shape.** `idx_wallets_chain_created_id (chain_id, created_at DESC, id DESC)` is dropped and replaced by `idx_wallets_user_created_id (user_id, created_at DESC, id DESC)`, because every list query now leads with `user_id = $1`.

5. **The down is lossy and refuses rather than losing rows.** Dropping `user_id` discards ownership permanently, and it cannot be recomputed. If two users share one `(address, chain_id)`, restoring `unique_address_chain` fails with a unique violation inside the runner's transaction, the whole down rolls back atomically, and the 0006 row survives in `schema_migrations`. A refusal is a recoverable state; a silent multi-user merge is not.

6. **Destructive replay fence.** The 0006 down is a schema-shape proof for disposable databases only (`wallet_evidence`, the CI service database). It must never run against the dev database that holds rows worth keeping, because the next `up` re-runs the unconditional purge and deletes every wallet created after the first up. The migration pair is not a safe down/up cycle on live data, and this is deliberate: the alternative was a nullable owner column with a backfill nobody can justify.

7. **Ownership is a query scope, not a domain field.** The domain `Wallet` struct keeps five fields and no `UserID`, so the response DTOs and their JSON stay untouched. The repository interface takes `userID` on all five operations, the service passes it through, and handlers read it only from the request context via `currentUser`. The request body can never set an owner. A row that exists under another user is reported as not found, byte for byte identical to a missing row, so ids cannot be probed across accounts and a 404 never becomes a 403.

## Consequences

- Every wallet route is owner scoped: `Create`, `GetByID`, `List`, `UpdateLabel` and `Delete` all carry the `user_id` predicate, in both backends.
- All five wallet routes require a bearer token. A tokenless request returns the house 401 before the handler runs.
- `service.UpdateLabel` resolves the scoped row before the all-nil no-op and before label validation, so a foreign or missing id is 404 even when the payload is invalid.
- Deleting a user cascades to their wallets and their sessions; another user's rows are unaffected.
- The wallet tables in `docs/database-schema.md` now describe the enforced shape rather than the proposed one.
