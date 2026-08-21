-- One-off: normalize mixed-case rows in `contracts`.
--
-- WHY
-- contracts.address is a case-sensitive varchar PRIMARY KEY, and every reader
-- looks it up lowercased. apps/indexer/src/contract-verifier.ts always lowercased
-- on write, but the public route apps/explorer/app/api/v1/verify/route.ts did not
-- until 8d40ee6 -- and its ADDRESS_REGEX accepts checksummed input. So any
-- verification submitted with a checksummed address wrote a row that nothing can
-- find, and the address page shows that contract as Unverified.
--
-- The code fix is prospective only. This repairs the rows already written.
--
-- ⚠ DO NOT RUN WHILE A RETENTION RUN IS IN FLIGHT. A BNB retention run holds the
-- database busy for 2-6 hours and a Render deploy/job during one has repeatedly
-- cost this project a full cycle. Confirm the run has printed its terminal
-- "disk PEAK" line first.
--
-- HOW TO RUN: as a read-only-then-write Render Job via @altscan/db (see the
-- project's Render Job recipe). Run STEP 0 alone first and read its output. If
-- mixed_case_rows is 0, there is nothing to do and you can stop.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0 — DRY RUN. Read-only. Safe at any time, including mid-retention.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  count(*) FILTER (WHERE c.address <> lower(c.address))                        AS mixed_case_rows,
  count(*) FILTER (WHERE c.address <> lower(c.address)
                     AND EXISTS (SELECT 1 FROM contracts l
                                  WHERE l.address = lower(c.address)))         AS colliding_rows,
  count(*) FILTER (WHERE c.address <> lower(c.address)
                     AND NOT EXISTS (SELECT 1 FROM contracts l
                                      WHERE l.address = lower(c.address)))     AS simple_renames
FROM contracts c;

-- Inspect them before changing anything:
-- SELECT address, verified_at, verify_source FROM contracts
--  WHERE address <> lower(address) ORDER BY verified_at DESC NULLS LAST;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — MIGRATION. Idempotent: a second run matches zero rows.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- 1a. Collisions: a lowercase row for the same address already exists, because
--     someone re-verified after the code fix. Keep the more recent verification.
--     A mixed-case row can never match itself here -- lower(m.address) <> m.address
--     is what put it in this set.
UPDATE contracts l
   SET abi              = m.abi,
       source_code      = m.source_code,
       compiler_version = m.compiler_version,
       verified_at      = m.verified_at,
       verify_source    = m.verify_source,
       license          = m.license,
       bytecode         = m.bytecode
  FROM contracts m
 WHERE m.address <> lower(m.address)
   AND l.address = lower(m.address)
   AND m.verified_at IS NOT NULL
   AND (l.verified_at IS NULL OR m.verified_at > l.verified_at);

-- 1b. Drop the now-redundant mixed-case duplicates. Only those whose lowercase
--     counterpart exists -- 1c handles the rest.
DELETE FROM contracts m
 WHERE m.address <> lower(m.address)
   AND EXISTS (SELECT 1 FROM contracts l WHERE l.address = lower(m.address));

-- 1c. No collision: normalize in place. Safe now that 1b removed every row whose
--     lowercased form would have conflicted.
UPDATE contracts
   SET address = lower(address)
 WHERE address <> lower(address);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — VERIFY. Must return 0. Re-running STEP 1 must then be a no-op.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT count(*) AS remaining_mixed_case FROM contracts WHERE address <> lower(address);
