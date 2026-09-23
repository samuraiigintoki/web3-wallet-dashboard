CREATE TABLE contracts (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chain_id         BIGINT NOT NULL,
    address          TEXT NOT NULL,
    start_block      BIGINT NOT NULL,
    indexing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE contracts
    ADD CONSTRAINT chk_contracts_start_block CHECK (start_block >= 0);

ALTER TABLE contracts
    ADD CONSTRAINT uq_contracts_chain_address UNIQUE (chain_id, address);

ALTER TABLE contracts
    ADD CONSTRAINT fk_contracts_chain_id
    FOREIGN KEY (chain_id) REFERENCES chains(chain_id) ON DELETE NO ACTION;

CREATE TABLE user_contracts (
    user_id     BIGINT NOT NULL,
    contract_id BIGINT NOT NULL,
    label       TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_contracts
    ADD CONSTRAINT pk_user_contracts PRIMARY KEY (user_id, contract_id);

ALTER TABLE user_contracts
    ADD CONSTRAINT fk_user_contracts_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE user_contracts
    ADD CONSTRAINT fk_user_contracts_contract_id
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE NO ACTION;

CREATE INDEX idx_user_contracts_user_enabled_created
    ON user_contracts (user_id, enabled, created_at DESC);