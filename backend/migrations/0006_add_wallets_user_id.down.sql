-- 0006 down: LOSSY. Dropping user_id discards ownership values permanently.
-- Refusal: while any two users share one (address, chain_id), restoring
-- unique_address_chain fails with a unique violation inside the runner's
-- transaction, the whole down rolls back atomically, and the 0006 version
-- row survives in schema_migrations.
-- Fence: this down is a schema-shape proof for disposable databases only
-- (wallet_evidence, CI service DB). Never run it against the real-data dev
-- database. Decision #1.
-- Replay warning: a subsequent up re-runs the unconditional purge and
-- deletes every wallet created after the first up.
DROP INDEX IF EXISTS idx_wallets_user_created_id;
CREATE INDEX IF NOT EXISTS idx_wallets_chain_created_id ON wallets (chain_id, created_at DESC, id DESC);
ALTER TABLE wallets DROP CONSTRAINT uq_wallets_user_chain_address;
ALTER TABLE wallets ADD CONSTRAINT unique_address_chain UNIQUE (address, chain_id);
ALTER TABLE wallets DROP COLUMN user_id;
