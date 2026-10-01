-- 0006: wallet user ownership for the B6 auth retrofit.
-- The DELETE is required: user_id is added as NOT NULL with no default, and that cannot be applied to a table that already holds rows (23502).
-- The choice to purge rather than fabricate ownership is policy, recorded in ADR 0003: the rows are pre-auth dev artifacts with no trustworthy row-to-user mapping, and no production deployment exists.
-- Precondition: API writers stopped (no cmd/api process running) for the
-- duration of this migration.
-- Down is lossy and refuses on cross-user duplicates; see the down file.
DELETE FROM wallets;
ALTER TABLE wallets ADD COLUMN user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE wallets DROP CONSTRAINT unique_address_chain;
ALTER TABLE wallets ADD CONSTRAINT uq_wallets_user_chain_address UNIQUE (user_id, chain_id, address);
DROP INDEX IF EXISTS idx_wallets_chain_created_id;
CREATE INDEX idx_wallets_user_created_id ON wallets (user_id, created_at DESC, id DESC);
