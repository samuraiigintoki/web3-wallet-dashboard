## Status
Accepted

## Context
The initial `docs/database-schema.md` design outlined a target multi-tenant model with `id UUID`, `user_id UUID (FK to users)`, `address VARCHAR(42)`, `updated_at TIMESTAMPTZ`, and `UNIQUE (user_id, chain_id, address)`.

In the initial implementation slice (Blocks 1–8), user authentication is deliberately deferred to focus on core transport, business logic, and repository layer seams. Additionally, the in-memory test double initially minted string IDs (`"w1"`, `"w2"`), whereas PostgreSQL was configured with `BIGINT GENERATED ALWAYS AS IDENTITY`.

## Decisions

1. **Primary Key & Identity Type:** 
   - Use `BIGINT GENERATED ALWAYS AS IDENTITY` for `wallets.id` in PostgreSQL.
   - Harmonize the Go domain model `Wallet.ID` to `int64` in Block 9 to align with relational integer identity without runtime string conversions.
   - **JSON Contract Update:** `wallets.id` in API responses will serialize as a JSON number (`int64`), updating previous string-based assumptions.

2. **Column Type Conventions (`address TEXT` vs `VARCHAR(42)`):**
   - Use `TEXT` for `address` and `label`. In PostgreSQL, `TEXT` and `VARCHAR` have identical storage engines and performance.
   - Format validation (`0x` prefix and exactly 42 characters) is enforced as a domain business rule at the service layer.

3. **Uniqueness Constraint & Indexing:**
   - Use `CONSTRAINT unique_address_chain UNIQUE (address, chain_id)` for single-tenant / unauthenticated MVP storage.
   - In PostgreSQL, the `UNIQUE` constraint automatically generates a supporting B-tree index on `(address, chain_id)`. Secondary indexes are deferred until query access patterns require them.
   - Multi-tenant `(user_id, chain_id, address)` constraints will be added via migration when authentication lands.

4. **Omission of `updated_at` in Migration 0001:**
   - Saved wallets in the current vertical slice are immutable upon creation (create and read only).
   - An `updated_at TIMESTAMPTZ` column will be introduced via a dedicated migration when wallet update endpoints (`PATCH /api/v1/wallets/{id}`) are implemented.

## Consequences
- The domain model, repository signatures, and response DTOs standardize on `int64` for database entity IDs.
- Eliminates premature coupling to user authentication while providing mathematical uniqueness guarantees at the database level.