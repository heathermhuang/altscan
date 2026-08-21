-- One-off: drop the two write-only columns from `addresses`.
--
-- WHY
-- Neither was ever maintained. apps/indexer/src/block-processor.ts was the only
-- writer and it inserted the literals '0' and false, with an ON CONFLICT clause
-- that updated only tx_count and last_seen. So every read of either was wrong:
--   * is_contract gated the address page's Contract badge AND its entire
--     verified-contract section — contract verification was invisible sitewide.
--   * balance was the fallback when live getBalance failed, turning an RPC blip
--     into a confident "0 BNB", and generateMetadata read it unconditionally so
--     every address page advertised "Balance: 0 BNB" to crawlers.
-- Both are now derived at read time (apps/explorer/lib/contract-status.ts).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ RUN THIS PER DATABASE, AND GATE EACH ONE INDEPENDENTLY.
-- ═══════════════════════════════════════════════════════════════════════════
-- There are TWO databases (bnbscan-db, ethscan-db) and TWO indexers
-- (bnbscan-indexer, eth-indexer) running this same code against them. They
-- deploy and can be rolled back independently, so "the code is deployed" is not
-- one fact — it is one fact per chain.
--
-- Before dropping on a given database, BOTH of that chain's services must be
-- live on a build that contains the schema change:
--     BNB : bnbscan-indexer  AND bnbscan-web
--     ETH : eth-indexer      AND ethscan-web
--
-- This is not tidiness. An indexer on the OLD build still lists balance and
-- is_contract in its INSERT, so every address upsert would raise. And that
-- failure is SILENT AND LOSSY: kickAddressFlush() moves the pending map into a
-- local snapshot and clears it BEFORE flushing, and flushAddresses' rejection is
-- only console.warn'd — nothing retries or re-queues. Those address rows are
-- gone permanently. Verify with the Render API, not by assumption:
--
--   curl -s -H "Authorization: Bearer $KEY" \
--     https://api.render.com/v1/services/<id>/deploys?limit=1
--
-- ⚠ FORWARD-ONLY once dropped. Rolling a service back to the preceding build
-- restores code that declares these columns, and the two bare
-- db.select().from(schema.addresses) call sites expand to every declared column
-- — so every address lookup would error. If you must roll back, run the ROLLBACK
-- block at the bottom FIRST. It is cheap: PostgreSQL 11+ adds a column with a
-- non-volatile default without rewriting the table.
--
-- ⚠ DO NOT RUN WHILE A RETENTION RUN IS IN FLIGHT. DROP COLUMN needs a brief
-- ACCESS EXCLUSIVE lock and will queue behind — then block — in-flight
-- statements. Wait for the run's terminal `VACUUM ANALYZE token_balances done`.
--
-- ⚠ THIS RECLAIMS NO DISK. DROP COLUMN is catalog-only; existing tuples keep
-- the bytes until rewritten. The gain is that NEW rows stop carrying ~8-9 bytes
-- of dead payload, roughly 5% of this table's measured ~55.7 MB/day growth. Do
-- not schedule it expecting space back.

-- ⚠ IF RUNNING VIA psql, `-v ON_ERROR_STOP=1` IS MANDATORY:
--
--     psql "$URL" -v ON_ERROR_STOP=1 -f scripts/drop-dead-addresses-columns.sql
--
-- Without it psql prints a raised exception and CONTINUES to the next statement,
-- so STEP 0 would abort and STEP 1 would drop the columns anyway. Running it the
-- repo's usual way — a Render Job through @altscan/db — has no such footgun: the
-- raised exception rejects the promise and the job fails.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0 — OPTIONAL PROOF. Run standalone, and read the cost note first.
--
-- This RAISES rather than printing. An earlier version of this script only
-- SELECTed the counts, which under `psql -f` prints them and then cheerfully
-- proceeds to the DDL anyway — a check that cannot fail is not a check.
--
-- ⚠ COST: a sequential scan of ~125M rows / ~19GB. There is no index on either
-- column. Skip it only if you accept the code-level proof instead: exactly one
-- INSERT writes these, it writes literals, its ON CONFLICT never touches them,
-- and a repo-wide search finds no other writer.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE bad_balance bigint; bad_flag bigint;
BEGIN
  SELECT count(*) FILTER (WHERE balance <> 0),
         count(*) FILTER (WHERE is_contract)
    INTO bad_balance, bad_flag
    FROM public.addresses;
  IF bad_balance > 0 OR bad_flag > 0 THEN
    RAISE EXCEPTION
      'REFUSING TO DROP: % rows carry a non-zero balance and % carry is_contract=true. '
      'Something outside this repo has been writing these columns, so the premise of '
      'this migration is wrong. Investigate before dropping.', bad_balance, bad_flag;
  END IF;
  RAISE NOTICE 'proof ok: every row still holds the defaults (balance=0, is_contract=false)';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — DROP. Idempotent via IF EXISTS.
--
-- lock_timeout bounds the ACCESS EXCLUSIVE wait so this fails fast instead of
-- queueing ahead of every reader and writer on a 125M-row table. If it times
-- out, that means the table is busy — retry when it is not.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.addresses DROP COLUMN IF EXISTS balance;
ALTER TABLE public.addresses DROP COLUMN IF EXISTS is_contract;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — VERIFY. Must return no rows.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'addresses'
   AND column_name IN ('balance', 'is_contract');

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK — run BEFORE reverting any service to a pre-drop build.
-- Fast in PostgreSQL 11+: a non-volatile default does not rewrite the table.
-- The restored columns hold defaults only, which is all they ever held.
-- ─────────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- ALTER TABLE public.addresses ADD COLUMN IF NOT EXISTS balance NUMERIC(36,18) NOT NULL DEFAULT 0;
-- ALTER TABLE public.addresses ADD COLUMN IF NOT EXISTS is_contract BOOLEAN NOT NULL DEFAULT false;
-- COMMIT;
