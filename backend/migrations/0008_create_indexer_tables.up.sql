-- 0008: Week 6 B1 indexer persistence.
--
-- Five tables for the event indexer:
--   indexer_checkpoints      progress and status per contract deployment
--   indexed_blocks           one canonical row per contract and block number
--   contract_events          decoded event history, including orphaned occurrences
--   multisig_transactions    current transaction projection
--   transaction_confirmations current owner confirmation projection
--
-- Canonical chain state lives in indexed_blocks and the two projections. Orphaned
-- event rows are retained with removed = TRUE so a rewind keeps history and can
-- rebuild projections from the remaining canonical events.
--
-- uint256 values use NUMERIC(78,0): exact decimal, never floating point. Addresses
-- and hashes carry shape CHECKs in addition to application validation because these
-- tables are written by a background process rather than by a request handler.

-- Additive index promised for Week 6 in docs/database-schema.md. The watch set
-- reads contracts by chain and global indexing flag.
CREATE INDEX idx_contracts_chain_indexing_enabled
    ON contracts (chain_id, indexing_enabled);

CREATE TABLE indexer_checkpoints (
    contract_id             BIGINT PRIMARY KEY,
    next_block              BIGINT NOT NULL,
    last_indexed_block      BIGINT,
    last_indexed_block_hash TEXT,
    status                  TEXT NOT NULL,
    last_error              TEXT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_indexer_checkpoints_contract_id
        FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE NO ACTION,
    CONSTRAINT chk_indexer_checkpoints_next_block
        CHECK (next_block >= 0),
    CONSTRAINT chk_indexer_checkpoints_last_indexed_block
        CHECK (last_indexed_block IS NULL OR last_indexed_block >= 0),
    CONSTRAINT chk_indexer_checkpoints_last_indexed_block_hash
        CHECK (last_indexed_block_hash IS NULL OR last_indexed_block_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT chk_indexer_checkpoints_status
        CHECK (status IN ('pending', 'running', 'idle', 'error', 'disabled', 'unsupported')),
    -- A sanitized error is stored only while the checkpoint is failing. Every other
    -- status transition must clear it.
    CONSTRAINT chk_indexer_checkpoints_last_error
        CHECK ((status = 'error' AND last_error IS NOT NULL)
            OR (status <> 'error' AND last_error IS NULL))
);

CREATE TABLE indexed_blocks (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_id  BIGINT NOT NULL,
    block_number BIGINT NOT NULL,
    block_hash   TEXT NOT NULL,
    parent_hash  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_indexed_blocks_contract_id
        FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE NO ACTION,
    CONSTRAINT uq_indexed_blocks_contract_block_number
        UNIQUE (contract_id, block_number),
    CONSTRAINT chk_indexed_blocks_block_number
        CHECK (block_number >= 0),
    CONSTRAINT chk_indexed_blocks_block_hash
        CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT chk_indexed_blocks_parent_hash
        CHECK (parent_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE TABLE contract_events (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_id       BIGINT NOT NULL,
    event_name        TEXT NOT NULL,
    block_number      BIGINT NOT NULL,
    block_hash        TEXT NOT NULL,
    transaction_hash  TEXT NOT NULL,
    transaction_index INTEGER NOT NULL,
    log_index         INTEGER NOT NULL,
    actor_address     TEXT,
    multisig_tx_index NUMERIC(78,0),
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
    removed           BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_contract_events_contract_id
        FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE NO ACTION,
    -- Event occurrence idempotency. The transaction hash is deliberately not part of
    -- the key: the same transaction may be re-included in a different block after a
    -- reorganization, and that is a distinct occurrence with its own block hash.
    CONSTRAINT uq_contract_events_occurrence
        UNIQUE (contract_id, block_hash, log_index),
    CONSTRAINT chk_contract_events_event_name
        CHECK (event_name IN ('SubmitTransaction', 'ConfirmTransaction', 'RevokeConfirmation', 'ExecuteTransaction')),
    CONSTRAINT chk_contract_events_block_number
        CHECK (block_number >= 0),
    CONSTRAINT chk_contract_events_transaction_index
        CHECK (transaction_index >= 0),
    CONSTRAINT chk_contract_events_log_index
        CHECK (log_index >= 0),
    CONSTRAINT chk_contract_events_block_hash
        CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT chk_contract_events_transaction_hash
        CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT chk_contract_events_actor_address
        CHECK (actor_address IS NULL OR actor_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT chk_contract_events_multisig_tx_index
        CHECK (multisig_tx_index IS NULL OR multisig_tx_index >= 0)
);

-- Projection rebuild reads one contract's nonremoved events in canonical order.
CREATE INDEX idx_contract_events_contract_order
    ON contract_events (contract_id, block_number, transaction_index, log_index);

CREATE INDEX idx_contract_events_contract_name_block
    ON contract_events (contract_id, event_name, block_number DESC);

CREATE INDEX idx_contract_events_contract_tx_index
    ON contract_events (contract_id, multisig_tx_index);

CREATE TABLE multisig_transactions (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_id          BIGINT NOT NULL,
    multisig_tx_index    NUMERIC(78,0) NOT NULL,
    to_address           TEXT,
    value_wei            NUMERIC(78,0),
    call_data            BYTEA,
    executed             BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_by         TEXT,
    submit_evm_tx_hash   TEXT,
    submit_block_number  BIGINT,
    execute_evm_tx_hash  TEXT,
    execute_block_number BIGINT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_multisig_transactions_contract_id
        FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE NO ACTION,
    CONSTRAINT uq_multisig_transactions_contract_tx_index
        UNIQUE (contract_id, multisig_tx_index),
    CONSTRAINT chk_multisig_transactions_multisig_tx_index
        CHECK (multisig_tx_index >= 0),
    CONSTRAINT chk_multisig_transactions_value_wei
        CHECK (value_wei IS NULL OR value_wei >= 0),
    -- Submit fields are nullable: indexing can start after the original submission,
    -- in which case a projection is built from the later confirm, revoke or execute
    -- events and the target of the transaction is unknown.
    CONSTRAINT chk_multisig_transactions_to_address
        CHECK (to_address IS NULL OR to_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT chk_multisig_transactions_submitted_by
        CHECK (submitted_by IS NULL OR submitted_by ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT chk_multisig_transactions_submit_evm_tx_hash
        CHECK (submit_evm_tx_hash IS NULL OR submit_evm_tx_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT chk_multisig_transactions_execute_evm_tx_hash
        CHECK (execute_evm_tx_hash IS NULL OR execute_evm_tx_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT chk_multisig_transactions_submit_block_number
        CHECK (submit_block_number IS NULL OR submit_block_number >= 0),
    CONSTRAINT chk_multisig_transactions_execute_block_number
        CHECK (execute_block_number IS NULL OR execute_block_number >= 0)
);

CREATE INDEX idx_multisig_transactions_contract_tx_index_desc
    ON multisig_transactions (contract_id, multisig_tx_index DESC);

CREATE INDEX idx_multisig_transactions_contract_executed
    ON multisig_transactions (contract_id, executed, multisig_tx_index DESC);

CREATE TABLE transaction_confirmations (
    multisig_transaction_id BIGINT NOT NULL,
    owner_address           TEXT NOT NULL,
    confirmed               BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_evm_tx_hash   TEXT,
    confirmed_block_number  BIGINT,
    revoked_evm_tx_hash     TEXT,
    revoked_block_number    BIGINT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT pk_transaction_confirmations
        PRIMARY KEY (multisig_transaction_id, owner_address),
    -- Projection rows are derived from multisig_transactions, so removing an orphaned
    -- transaction takes its confirmations with it.
    CONSTRAINT fk_transaction_confirmations_multisig_transaction_id
        FOREIGN KEY (multisig_transaction_id) REFERENCES multisig_transactions(id) ON DELETE CASCADE,
    CONSTRAINT chk_transaction_confirmations_owner_address
        CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT chk_transaction_confirmations_confirmed_evm_tx_hash
        CHECK (confirmed_evm_tx_hash IS NULL OR confirmed_evm_tx_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT chk_transaction_confirmations_revoked_evm_tx_hash
        CHECK (revoked_evm_tx_hash IS NULL OR revoked_evm_tx_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT chk_transaction_confirmations_confirmed_block_number
        CHECK (confirmed_block_number IS NULL OR confirmed_block_number >= 0),
    CONSTRAINT chk_transaction_confirmations_revoked_block_number
        CHECK (revoked_block_number IS NULL OR revoked_block_number >= 0)
);

CREATE INDEX idx_transaction_confirmations_transaction_confirmed
    ON transaction_confirmations (multisig_transaction_id, confirmed);
