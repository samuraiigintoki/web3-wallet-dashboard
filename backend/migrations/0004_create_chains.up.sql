CREATE TABLE IF NOT EXISTS chains (
    chain_id BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    is_testnet BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO chains (chain_id, name, symbol, is_testnet)
VALUES
    (1, 'Ethereum', 'ETH', FALSE),
    (137, 'Polygon', 'POL', FALSE),
    (11155111, 'Sepolia', 'ETH', TRUE)
ON CONFLICT (chain_id) DO NOTHING;

ALTER TABLE wallets
    ADD CONSTRAINT fk_wallets_chain_id
    FOREIGN KEY (chain_id) REFERENCES chains(chain_id)
    ON DELETE NO ACTION;


