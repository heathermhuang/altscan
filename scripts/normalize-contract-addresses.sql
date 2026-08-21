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

-- Addresses with MORE THAN ONE casing variant. These are what break a naive
-- in-place rename, so it is worth knowing whether any exist before you start.
SELECT lower(address) AS dst, count(*) AS variants, array_agg(address) AS casings
  FROM contracts
 GROUP BY lower(address) HAVING count(*) > 1;

-- Inspect them before changing anything:
-- SELECT address, verified_at, verify_source FROM contracts
--  WHERE address <> lower(address) ORDER BY verified_at DESC NULLS LAST;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — MIGRATION. Idempotent: a second run finds no targets and does nothing.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- Block concurrent verification writes for the duration. Without this, a
-- verification landing mid-transaction can be deleted without being merged.
-- `contracts` holds only verified contracts so it is small, and SHARE ROW
-- EXCLUSIVE still permits readers.
LOCK TABLE contracts IN SHARE ROW EXCLUSIVE MODE;

-- Collapse every casing variant of an affected address into ONE best row.
--
-- Aggregating field-by-field rather than picking a single winning ROW is the
-- point. The public verify route writes only bytecode/verified_at/verify_source/
-- compiler_version, leaving abi, source_code and license NULL, while the
-- indexer's Sourcify path fills them in. Choosing the newest row wholesale would
-- therefore let a newer, thinner public-route row destroy richer older data.
--
-- Each ORDER BY puts non-NULL (and, for bytecode, non-placeholder) values first,
-- then most-recently-verified. So every field independently takes the freshest
-- REAL value available across all variants, including the lowercase row itself —
-- it is joined in deliberately so the merge can never lose what it already had.
CREATE TEMP TABLE _merged ON COMMIT DROP AS
WITH targets AS (
  SELECT DISTINCT lower(address) AS dst FROM contracts WHERE address <> lower(address)
)
SELECT t.dst,
       (array_agg(c.bytecode ORDER BY (c.bytecode IS NULL OR c.bytecode IN ('', '0x')),
                  c.verified_at DESC NULLS LAST, c.address))[1]                      AS bytecode,
       (array_agg(c.abi ORDER BY (c.abi IS NULL),
                  c.verified_at DESC NULLS LAST, c.address))[1]                      AS abi,
       (array_agg(c.source_code ORDER BY (c.source_code IS NULL),
                  c.verified_at DESC NULLS LAST, c.address))[1]                      AS source_code,
       (array_agg(c.compiler_version ORDER BY (c.compiler_version IS NULL),
                  c.verified_at DESC NULLS LAST, c.address))[1]                      AS compiler_version,
       (array_agg(c.verify_source ORDER BY (c.verify_source IS NULL),
                  c.verified_at DESC NULLS LAST, c.address))[1]                      AS verify_source,
       (array_agg(c.license ORDER BY (c.license IS NULL),
                  c.verified_at DESC NULLS LAST, c.address))[1]                      AS license,
       max(c.verified_at)                                                            AS verified_at
  FROM targets t
  JOIN contracts c ON lower(c.address) = t.dst
 GROUP BY t.dst;

-- Replace rather than rename. An in-place `SET address = lower(address)` breaks
-- the moment an address has two mixed-case variants (0xAAA1 and 0xAaA1 both
-- lowercase to the same key): they collide on the primary key and roll the whole
-- migration back. Deleting every variant and inserting the single merged row
-- cannot collide, whatever the number of variants.
DELETE FROM contracts WHERE lower(address) IN (SELECT dst FROM _merged);

INSERT INTO contracts (address, bytecode, abi, source_code, compiler_version,
                       verified_at, verify_source, license)
SELECT dst, COALESCE(bytecode, '0x'), abi, source_code, compiler_version,
       verified_at, verify_source, license
  FROM _merged;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — VERIFY. Must return 0. Re-running STEP 1 must then be a no-op.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT count(*) AS remaining_mixed_case FROM contracts WHERE address <> lower(address);
