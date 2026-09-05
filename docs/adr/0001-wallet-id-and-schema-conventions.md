# ADR 0001: Wallet Identity Type and MVP Schema Conventions

## Status
Accepted

## Context
The initial `docs/database-schema.md` design outlined a target multi-tenant model with `id UUID`, `user_id UUID (FK to users)`, and `UNIQUE (user_id, chain_id, address)`. 

In the initial implementation slice (Blocks 1–8), authentication and user management are deliberately out of scope to prioritize transport, business logic, and repository layer seams. 

Additionally, the in-memory test double minted string IDs (`"w1"`, `"w2"`), whereas PostgreSQL was configured with `BIGINT GENERATED ALWAYS AS IDENTITY`.

## Decision
1. **Primary Key Type:** Use `BIGINT GENERATED ALWAYS AS IDENTITY` for `wallets.id` in PostgreSQL. Harmonize the Go domain model `Wallet.ID` to `int64` in Block 9 to align with standard relational integer identity without silent driver conversions.
2. **Uniqueness Constraint:** Use `CONSTRAINT unique_address_chain UNIQUE (address, chain_id)` for single-tenant / unauthenticated MVP storage. Multi-tenant `(user_id, chain_id, address)` constraints will be added via migration when authentication lands.
3. **Immutability:** Schema changes will strictly be versioned via sequential `backend/migrations/*.sql` files.

## Consequences
- The domain model and repository signatures will standardize on `int64` for database entity IDs.
- Eliminates premature coupling to user authentication while providing mathematical uniqueness guarantees at the database level.