-- Database optimization for BNBScan / EthScan
-- Run against each database: psql $DATABASE_URL -f scripts/db-optimize.sql
--
-- Safe to run multiple times (all statements are IF NOT EXISTS / idempotent)
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction,
-- so this script must NOT be wrapped in BEGIN/COMMIT.

-----------------------------------------------------------------------
-- 1. Composite indexes for address page queries
--    These turn (index scan + sort) into direct index range scans
--    for queries like: WHERE from_address = $1 ORDER BY timestamp DESC
--    CONCURRENTLY = no table lock, safe on live databases
-----------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_from_ts_idx
  ON transactions (from_address, "timestamp" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_to_ts_idx
  ON transactions (to_address, "timestamp" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_from_ts_idx
  ON token_transfers (from_address, "timestamp" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tt_to_ts_idx
  ON token_transfers (to_address, "timestamp" DESC);

-----------------------------------------------------------------------
-- 2. Data retention: prune old low-value data
--    These tables grow fast but old rows are rarely queried
--    Uses batched deletes to avoid long locks
-----------------------------------------------------------------------

-- gas_history: keep last 30 days (used only for gas tracker page)
DELETE FROM gas_history
WHERE "timestamp" < NOW() - INTERVAL '30 days';

-- logs: keep last 60 days (used for contract event lookups)
-- This is typically the largest table after transactions/token_transfers
DELETE FROM logs
WHERE block_number < (
  SELECT COALESCE(MIN(number), 0) FROM blocks
  WHERE "timestamp" > NOW() - INTERVAL '60 days'
);

-- dex_trades: keep last 60 days (used for DEX analytics)
DELETE FROM dex_trades
WHERE "timestamp" < NOW() - INTERVAL '60 days';

-----------------------------------------------------------------------
-- 3. Reclaim space from deleted rows
-----------------------------------------------------------------------

VACUUM ANALYZE gas_history;
VACUUM ANALYZE logs;
VACUUM ANALYZE dex_trades;

-- Update statistics on the big tables (no space reclaim, just planner stats)
ANALYZE transactions;
ANALYZE token_transfers;
ANALYZE blocks;
