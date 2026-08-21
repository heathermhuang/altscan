-- One-off: drop the two write-only columns from `addresses`.
--
-- WHY
-- Neither was ever maintained. apps/indexer/src/block-processor.ts was the only
-- writer and it inserted the literals '0' and false, with an ON CONFLICT clause
-- that updated only tx_count and last_seen. So every read of either was wrong:
--   * is_contract gated the address page's Contract badge AND its entire
--     verified-contract section, which is why contract verification was
--     invisible sitewide until PR #105.
--   * balance was the fallback when live getBalance failed, turning an RPC blip
--     into a confident "0 BNB", and generateMetadata read it unconditionally so
--     every address page advertised "Balance: 0 BNB" to crawlers.
-- Both are now derived at read time (apps/explorer/lib/contract-status.ts).
--
-- ⚠ ORDERING MATTERS. Deploy the code change that removes these from the Drizzle
-- schema FIRST. Two call sites use a bare `db.select().from(schema.addresses)`,
-- which expands to every DECLARED column — running this DROP while the deployed
-- code still declares them turns every address lookup into an error.
--
--   1. merge + deploy the branch that removes them from packages/db/schema.ts
--   2. confirm the indexer and BOTH web services are live on that build
--   3. only then run this
--
-- ⚠ DO NOT RUN WHILE A RETENTION RUN IS IN FLIGHT. DROP COLUMN needs a brief
-- ACCESS EXCLUSIVE lock, and on a table this busy it will queue behind — and
-- then block — in-flight statements. Wait for the run's terminal VACUUM line.
--
-- ⚠ THIS RECLAIMS NO DISK. In PostgreSQL, DROP COLUMN is catalog-only: existing
-- tuples keep the bytes until they are rewritten. The gain is that NEW rows stop
-- carrying ~8-9 bytes of dead payload, which is roughly 5% of this table's
-- ~55.7 MB/day growth. Do not schedule this expecting space back; a rewrite
-- (VACUUM FULL / pg_repack) would be needed for that and will not fit on a
-- 150GB volume at ~80%.

-- STEP 0 — confirm the columns are still there, and that nothing but the
-- defaults was ever written. Read-only; safe at any time.
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'addresses' AND column_name IN ('balance', 'is_contract');

-- Proof they are dead. Expect zeros. If either is non-zero, STOP: something
-- outside this repo has been writing them and the premise is wrong.
SELECT count(*) FILTER (WHERE balance <> 0)        AS non_zero_balances,
       count(*) FILTER (WHERE is_contract)         AS true_is_contract
  FROM addresses;

-- STEP 1 — drop. Idempotent via IF EXISTS.
BEGIN;
-- Fail fast rather than queue forever behind a long statement; on a 100M+ row
-- table an unbounded ACCESS EXCLUSIVE wait can stall ingestion behind it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE addresses DROP COLUMN IF EXISTS balance;
ALTER TABLE addresses DROP COLUMN IF EXISTS is_contract;
COMMIT;

-- STEP 2 — verify. Must return no rows.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'addresses' AND column_name IN ('balance', 'is_contract');
