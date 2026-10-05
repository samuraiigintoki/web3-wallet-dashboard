-- Rollback for 0008. Drop in reverse dependency order and remove the watch-set
-- index added by the up migration. Nothing outside this migration is touched.

DROP TABLE IF EXISTS transaction_confirmations;
DROP TABLE IF EXISTS multisig_transactions;
DROP TABLE IF EXISTS contract_events;
DROP TABLE IF EXISTS indexed_blocks;
DROP TABLE IF EXISTS indexer_checkpoints;

DROP INDEX IF EXISTS idx_contracts_chain_indexing_enabled;
