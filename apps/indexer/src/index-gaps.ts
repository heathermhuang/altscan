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
          healed_at = NULL
  `)
  return true
}
