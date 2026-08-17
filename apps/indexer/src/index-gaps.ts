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
 * Row count of a driver result, or a throw if the shape is not one we recognise.
 *
 * Strict on purpose. These helpers gate quarantine, and their callers read `false`
 * as the positive claim "the block already exists" — so any shape we do not
 * genuinely understand must NOT be flattened into that answer. An earlier version
 * accepted anything with a numeric `length`, which quietly admitted `''` and
 * `{ length: 0 }` as "zero rows". A throw lands in the caller's catch, which
 * declines to skip and retries: the block stays pinned, which is the safe outcome.
 * (codex P2, rounds 3 and 4.)
 */
function rowCount(res: unknown): number {
  if (Array.isArray(res)) return res.length
  // postgres-js returns a RowList: array-like AND iterable. Require both, so a bare
  // string (array-like, iterable over characters) cannot pass as a row set.
  if (
    res != null && typeof res === 'object' &&
    typeof (res as ArrayLike<unknown>).length === 'number' &&
    typeof (res as Iterable<unknown>)[Symbol.iterator] === 'function'
  ) {
    return (res as ArrayLike<unknown>).length
  }
  throw new Error(`[index-gaps] unrecognised db.execute result shape: ${Object.prototype.toString.call(res)}`)
}

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
  failures: number,
): Promise<boolean> {
  if (!Number.isFinite(block) || !Number.isFinite(failures)) return false
  // ONE statement, so all three parts share a snapshot and commit together:
  //   • the absence test      — never quarantine a block that already exists
  //   • the index_gaps row    — completeness reporting (/api/health degraded)
  //   • the poison_blocks row — the durable skip DECISION the resume scan honours
  //
  // Both-or-neither matters. A gap without a decision leaves the next boot unable
  // to recognise the skip (the restart deadlock); a decision without a gap steps
  // over a block that health reports as fine — the exact silent loss this whole
  // mechanism exists to prevent. Two sequential statements make either half
  // reachable on a failure in between. A data-modifying CTE is one implicit
  // transaction and every branch reads the same `absent` CTE, so the two inserts
  // cannot disagree about absence.
  //
  // DbLike.execute is intentionally `unknown`-returning so this module stays
  // unit-testable without a drizzle client. Narrow it here rather than widening
  // the shared type, and treat a non-iterable result as "not recorded" — the
  // fail-closed answer, since it leaves the cursor pinned and retrying.
  const res = (await db.execute(sql`
    WITH absent AS (
      SELECT 1 AS ok WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE number = ${block})
    ),
    gap AS (
      INSERT INTO index_gaps (from_block, to_block, reason)
      SELECT ${block}, ${block}, ${reason} FROM absent
      ON CONFLICT (from_block) DO UPDATE
        SET to_block  = GREATEST(index_gaps.to_block, EXCLUDED.to_block),
            reason    = EXCLUDED.reason,
            healed_at = NULL,
            heal_cursor = CASE WHEN index_gaps.healed_at IS NOT NULL
                               THEN NULL ELSE index_gaps.heal_cursor END
      RETURNING from_block
    )
    INSERT INTO poison_blocks (block_number, failures)
    SELECT ${block}, ${failures} FROM absent
    ON CONFLICT (block_number) DO UPDATE
      SET failures    = EXCLUDED.failures,
          recorded_at = now()
    RETURNING block_number
  `)) as ArrayLike<unknown> | null | undefined
  // A `false` return MUST mean exactly one thing: the block is present. The caller
  // reads it as proof of that and logs "its row already EXISTS". Folding an
  // unrecognised result shape into the same `false` would let a driver or adapter
  // change silently disable quarantine while reporting a confident, wrong reason —
  // so an unexpected shape throws instead, landing in the caller's catch, which
  // declines to skip and retries. (codex P2, round 3.)
  if (res == null || typeof (res as ArrayLike<unknown>).length !== 'number') {
    throw new Error('[index-gaps] recordPoisonGapIfAbsent: unrecognised result shape from db.execute')
  }
  return Array.from(res).length > 0
}

/**
 * Does this exact height carry a durable skip decision?
 *
 * Reads poison_blocks, NOT `index_gaps.reason`. The reason column is overwritten
 * by whichever gap writer touches the row last, so matching on it meant an
 * unrelated max_lag_skip could silently erase a quarantine's identity — and the
 * symptom of that erasure is the restart deadlock, not an error. (codex P1,
 * round 2.)
 */
export async function isPoisonBlock(db: DbLike, block: number): Promise<boolean> {
  if (!Number.isFinite(block)) return false
  const res = (await db.execute(
    sql`SELECT 1 FROM poison_blocks WHERE block_number = ${block} LIMIT 1`,
  ))
  return rowCount(res) > 0
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
