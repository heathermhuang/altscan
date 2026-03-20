-- BNBScan database schema
-- Generated manually from packages/db/schema.ts (drizzle-kit v0.22.8 has BigInt serialization bug)

-- Enums
CREATE TYPE token_type AS ENUM ('BEP20', 'BEP721', 'BEP1155');
CREATE TYPE validator_status AS ENUM ('active', 'inactive', 'jailed');
CREATE TYPE verify_source AS ENUM ('own', 'sourcify');

-- blocks
CREATE TABLE IF NOT EXISTS blocks (
  number        BIGINT PRIMARY KEY,
  hash          VARCHAR(66) NOT NULL UNIQUE,
  parent_hash   VARCHAR(66) NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL,
  miner         VARCHAR(42) NOT NULL,
  gas_used      BIGINT NOT NULL,
  gas_limit     BIGINT NOT NULL,
  base_fee_per_gas NUMERIC(36, 0),
  tx_count      INTEGER NOT NULL DEFAULT 0,
  size          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS blocks_miner_idx     ON blocks (miner);
CREATE INDEX IF NOT EXISTS blocks_timestamp_idx ON blocks (timestamp);

-- transactions
CREATE TABLE IF NOT EXISTS transactions (
  hash          VARCHAR(66) PRIMARY KEY,
  block_number  BIGINT NOT NULL REFERENCES blocks(number),
  from_address  VARCHAR(42) NOT NULL,
  to_address    VARCHAR(42),
  value         NUMERIC(78, 18) NOT NULL DEFAULT '0',
  gas           BIGINT NOT NULL,
  gas_price     NUMERIC(36, 0) NOT NULL,
  gas_used      BIGINT NOT NULL DEFAULT 0,
  input         TEXT NOT NULL DEFAULT '0x',
  status        BOOLEAN NOT NULL DEFAULT TRUE,
  method_id     VARCHAR(10),
  tx_index      INTEGER NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS tx_from_idx      ON transactions (from_address);
CREATE INDEX IF NOT EXISTS tx_to_idx        ON transactions (to_address);
CREATE INDEX IF NOT EXISTS tx_block_idx     ON transactions (block_number);
CREATE INDEX IF NOT EXISTS tx_timestamp_idx ON transactions (timestamp);

-- addresses
CREATE TABLE IF NOT EXISTS addresses (
  address       VARCHAR(42) PRIMARY KEY,
  balance       NUMERIC(36, 18) NOT NULL DEFAULT '0',
  tx_count      INTEGER NOT NULL DEFAULT 0,
  is_contract   BOOLEAN NOT NULL DEFAULT FALSE,
  label         VARCHAR(255),
  first_seen    TIMESTAMPTZ,
  last_seen     TIMESTAMPTZ
);

-- token_transfers
CREATE TABLE IF NOT EXISTS token_transfers (
  id            SERIAL PRIMARY KEY,
  tx_hash       VARCHAR(66) NOT NULL,
  log_index     INTEGER NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  from_address  VARCHAR(42) NOT NULL,
  to_address    VARCHAR(42) NOT NULL,
  value         NUMERIC(78, 0) NOT NULL DEFAULT '0',
  token_id      NUMERIC(78, 0),
  block_number  BIGINT NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS tt_token_idx ON token_transfers (token_address);
CREATE INDEX IF NOT EXISTS tt_from_idx  ON token_transfers (from_address);
CREATE INDEX IF NOT EXISTS tt_to_idx    ON token_transfers (to_address);
CREATE INDEX IF NOT EXISTS tt_tx_idx    ON token_transfers (tx_hash);
CREATE INDEX IF NOT EXISTS tt_block_idx ON token_transfers (block_number);

-- tokens
CREATE TABLE IF NOT EXISTS tokens (
  address       VARCHAR(42) PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  symbol        VARCHAR(50) NOT NULL,
  decimals      INTEGER NOT NULL DEFAULT 18,
  type          token_type NOT NULL DEFAULT 'BEP20',
  total_supply  NUMERIC(78, 0) NOT NULL DEFAULT '0',
  holder_count  INTEGER NOT NULL DEFAULT 0,
  logo_url      TEXT
);

-- logs
CREATE TABLE IF NOT EXISTS logs (
  id            SERIAL PRIMARY KEY,
  tx_hash       VARCHAR(66) NOT NULL,
  log_index     INTEGER NOT NULL,
  address       VARCHAR(42) NOT NULL,
  topic0        VARCHAR(66),
  topic1        VARCHAR(66),
  topic2        VARCHAR(66),
  topic3        VARCHAR(66),
  data          TEXT NOT NULL DEFAULT '0x',
  block_number  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS logs_address_topic0_idx ON logs (address, topic0);
CREATE INDEX IF NOT EXISTS logs_tx_idx             ON logs (tx_hash);

-- contracts
CREATE TABLE IF NOT EXISTS contracts (
  address          VARCHAR(42) PRIMARY KEY,
  bytecode         TEXT NOT NULL,
  abi              JSONB,
  source_code      TEXT,
  compiler_version VARCHAR(50),
  verified_at      TIMESTAMPTZ,
  verify_source    verify_source,
  license          VARCHAR(100)
);

-- dex_trades
CREATE TABLE IF NOT EXISTS dex_trades (
  id            SERIAL PRIMARY KEY,
  tx_hash       VARCHAR(66) NOT NULL,
  dex           VARCHAR(50) NOT NULL,
  pair_address  VARCHAR(42) NOT NULL,
  token_in      VARCHAR(42) NOT NULL,
  token_out     VARCHAR(42) NOT NULL,
  amount_in     NUMERIC(78, 0) NOT NULL,
  amount_out    NUMERIC(78, 0) NOT NULL,
  maker         VARCHAR(42) NOT NULL,
  block_number  BIGINT NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS dex_maker_idx ON dex_trades (maker);
CREATE INDEX IF NOT EXISTS dex_pair_idx  ON dex_trades (pair_address);
CREATE INDEX IF NOT EXISTS dex_block_idx ON dex_trades (block_number);

-- validators
CREATE TABLE IF NOT EXISTS validators (
  address       VARCHAR(42) PRIMARY KEY,
  moniker       VARCHAR(255) NOT NULL,
  voting_power  NUMERIC(36, 0) NOT NULL DEFAULT '0',
  commission    NUMERIC(5, 4) NOT NULL DEFAULT '0',
  uptime        NUMERIC(5, 4) NOT NULL DEFAULT '0',
  status        validator_status NOT NULL DEFAULT 'active',
  updated_at    TIMESTAMPTZ NOT NULL
);

-- gas_history
CREATE TABLE IF NOT EXISTS gas_history (
  id            SERIAL PRIMARY KEY,
  slow          NUMERIC(36, 0) NOT NULL,
  standard      NUMERIC(36, 0) NOT NULL,
  fast          NUMERIC(36, 0) NOT NULL,
  base_fee      NUMERIC(36, 0) NOT NULL,
  block_number  BIGINT NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL
);
