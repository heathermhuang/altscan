-- Database optimization for BNBScan / EthScan
-- Run against each database: psql $DATABASE_URL -f scripts/db-optimize.sql
--
-- Safe to run multiple times (all statements are idempotent)
-- Retention catch-up and VACUUM only — see the index note below.

-----------------------------------------------------------------------
-- Indexes are NOT managed here.
--
-- They used to be: sections 1 and 2 of this file dropped four redundant
-- single-column indexes and created the composites, including
--   tx_ts_value_idx  ON transactions (timestamp DESC, value DESC)
--   tt_token_ts_idx  ON token_transfers (token_address, timestamp DESC)
-- added "for whale tracker page" in da8e513 on 2026-04-08.
--
-- Nothing has ever executed this file. The only reference to it anywhere in
-- the repo is an echo in db-maintenance.sh telling a human to run it, and on
-- 2026-08-27 both production databases were checked directly: neither of those
-- two indexes existed on either chain, four and a half months later. The
-- Whale Tracker was seq-scanning `transactions` and `token_transfers` on every
-- request and timing out against its own 15s budget.
--
-- The index DDL now lives in apps/indexer/src/ensure-schema.ts, which actually
-- runs, on every indexer boot, on both chains. Do not re-add indexes here:
-- a second place to declare them is what produced a 4-month outage that
-- nobody could see, because the file looked like it had already fixed it.
--
-- (tt_token_ts_idx cannot be expressed in this file at all on BNB: its
-- token_transfers is RANGE-partitioned, and CREATE INDEX CONCURRENTLY is
-- rejected on a partitioned parent. That statement would have errored here
-- even if someone had run it. ensure-schema builds it per-partition instead.)
-----------------------------------------------------------------------

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
