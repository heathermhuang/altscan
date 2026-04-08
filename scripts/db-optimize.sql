-- Database optimization for BNBScan / EthScan
-- Run against each database: psql $DATABASE_URL -f scripts/db-optimize.sql
--
-- Safe to run multiple times (all statements are idempotent)
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction,
-- so this script must NOT be wrapped in BEGIN/COMMIT.

-----------------------------------------------------------------------
-- 1. Drop redundant single-column indexes
--    Composite indexes (address, timestamp) already cover single-address
--    lookups. Each redundant index wastes ~2-4GB on 40M+ row tables.
-----------------------------------------------------------------------

DROP INDEX CONCURRENTLY IF EXISTS tx_from_idx;
DROP INDEX CONCURRENTLY IF EXISTS tx_to_idx;
DROP INDEX CONCURRENTLY IF EXISTS tt_from_idx;
DROP INDEX CONCURRENTLY IF EXISTS tt_to_idx;

-----------------------------------------------------------------------
-- 2. Ensure composite indexes exist (idempotent)
-----------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_from_ts_idx
  ON transactions (from_address, "timestamp" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_to_ts_idx
  ON transactions (to_address, "timestamp" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_from_ts_idx
  ON token_transfers (from_address, "timestamp" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_to_ts_idx
  ON token_transfers (to_address, "timestamp" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_ts_value_idx
  ON transactions ("timestamp" DESC, value DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_token_ts_idx
  ON token_transfers (token_address, "timestamp" DESC);

-----------------------------------------------------------------------
-- 3. Data retention: keep 7 days of high-volume data
--    The indexer retention-cleanup runs every 6h, but if it falls behind
--    (e.g. after a DB outage), this script catches up.
--    Delete order: token_transfers → transactions → blocks (FK order)
-----------------------------------------------------------------------

DELETE FROM token_transfers
WHERE "timestamp" < NOW() - INTERVAL '7 days';

DELETE FROM dex_trades
WHERE "timestamp" < NOW() - INTERVAL '7 days';

DELETE FROM gas_history
WHERE "timestamp" < NOW() - INTERVAL '7 days';

DELETE FROM logs
WHERE block_number < (
  SELECT COALESCE(MIN(number), 0) FROM blocks
  WHERE "timestamp" > NOW() - INTERVAL '7 days'
);

DELETE FROM transactions
WHERE "timestamp" < NOW() - INTERVAL '7 days';

DELETE FROM blocks
WHERE "timestamp" < NOW() - INTERVAL '7 days';

-- Clean up zero-balance token holders
DELETE FROM token_balances WHERE balance <= 0;

-----------------------------------------------------------------------
-- 4. Reclaim disk space
--    VACUUM FULL rewrites the table and returns space to the OS.
--    It locks the table, so only use during maintenance windows.
--    Use plain VACUUM ANALYZE for routine runs.
-----------------------------------------------------------------------

VACUUM ANALYZE token_transfers;
VACUUM ANALYZE transactions;
VACUUM ANALYZE blocks;
VACUUM ANALYZE logs;
VACUUM ANALYZE dex_trades;
VACUUM ANALYZE gas_history;
VACUUM ANALYZE token_balances;
