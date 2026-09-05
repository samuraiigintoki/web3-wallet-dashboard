CREATE TABLE wallets ( 
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    address TEXT NOT NULL ,
    chain_id BIGINT NOT NULL, 
    label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_address_chain UNIQUE (address, chain_id)
);