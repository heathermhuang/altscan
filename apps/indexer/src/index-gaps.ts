import { sql } from 'drizzle-orm'

/**
 * Record a deliberately-abandoned block range (the MAX_LAG_BLOCKS skip).
 *
 * The skip jumps the cursor past blocks that will never be indexed. It has
 * always done so and always recorded nothing, which turned "the indexer is
 * behind" (a freshness problem) into "the index is wrong" (a correctness one),
 * invisibly: ~92,000 blocks between 2026-08-04 and 08-11 with /api/health
 * reporting `{"status":"ok"}` the whole time.
 *
 * Recording the range makes the loss alertable now (see the explorer's
 * /api/health completeness block) and backfillable later.
 */

/** Just the slice of the drizzle client this needs — keeps it unit-testable. */
type DbLike = { execute: (query: unknown) => Promise<unknown> }

/**
 * Record a ONE-block quarantine gap, but only if the block is still absent.
 *
 * Separate from recordIndexGap because the absence test must be part of the SAME
 * statement as the insert. Checking absence in one round trip and inserting in
 * another leaves a window in which the overlapping deploy generation (Render runs
 * both binaries for 60-80s) can cross its first write and leave the block
 * partially persisted — and a gap recorded over a partially-persisted block is the
 * unhealable, invisible state quarantine exists to avoid, because the gap healer's
 * work set is ABSENT blocks only. (codex P1, round 1.)
 *
 * This narrows the window to the statement's own atomicity rather than eliminating
 * it: a writer that has not yet COMMITTED its block row is invisible to this
 * SELECT under MVCC, so it can still commit a partial block immediately after.
 * Fully closing that would need a fence the writer also respects (an advisory lock
 * on the height, taken inside processBlock). Documented, not silently assumed.
 *
 * Returns true only if a row was actually recorded.
 */
export async function recordPoisonGapIfAbsent(
  db: DbLike,
  block: number,
  reason: string,
): Promise<boolean> {
  if (!Number.isFinite(block)) return false
  // DbLike.execute is intentionally `unknown`-returning so this module stays
  // unit-testable without a drizzle client. Narrow it here rather than widening
  // the shared type, and treat a non-iterable result as "not recorded" — the
  // fail-closed answer, since it leaves the cursor pinned and retrying.
  const res = (await db.execute(sql`
    INSERT INTO index_gaps (from_block, to_block, reason)
    SELECT ${block}, ${block}, ${reason}
    WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE number = ${block})
    ON CONFLICT (from_block) DO UPDATE
      SET to_block  = GREATEST(index_gaps.to_block, EXCLUDED.to_block),
          reason    = EXCLUDED.reason,
          healed_at = NULL,
          heal_cursor = CASE WHEN index_gaps.healed_at IS NOT NULL
                             THEN NULL ELSE index_gaps.heal_cursor END
    RETURNING from_block
  `)) as ArrayLike<unknown> | null | undefined
  if (res == null || typeof (res as ArrayLike<unknown>).length !== 'number') return false
  return Array.from(res).length > 0
}

export async function recordIndexGap(
  db: DbLike,
  fromBlock: number,
  toBlock: number,
  reason: string,
): Promise<boolean> {
  // Guarded HERE rather than at the call site so it cannot be bypassed by a
  // future caller. The bounds are computed arithmetically upstream, and an
  // inverted range means nothing was actually abandoned — writing it would trip
  // the table's CHECK constraint and throw inside the poll loop.
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) return false
  if (toBlock < fromBlock) return false

  await db.execute(sql`
    INSERT INTO index_gaps (from_block, to_block, reason)
    VALUES (${fromBlock}, ${toBlock}, ${reason})
    ON CONFLICT (from_block) DO UPDATE
      SET to_block  = GREATEST(index_gaps.to_block, EXCLUDED.to_block),
          reason    = EXCLUDED.reason,
          -- Re-abandoning a previously healed range means it is missing again.
          healed_at = NULL,
          -- Reopening a HEALED row must also drop its heal progress. The cursor
          -- would otherwise still sit at the old to_block, so heal_from lands past
          -- the end, every tick works an empty window, the final proof fails, and
          -- the range can never heal again. Progress on a row that was ALREADY
          -- unhealed is real and is kept — this only resets the healed->unhealed
          -- transition. (codex P2, round 4.)
          heal_cursor = CASE WHEN index_gaps.healed_at IS NOT NULL
                             THEN NULL ELSE index_gaps.heal_cursor END
  `)
  return true
}
