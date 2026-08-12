import { sql } from 'drizzle-orm'

/**
 * Heal the ranges `index_gaps` records.
 *
 * #94 made abandoned ranges VISIBLE but nothing ever cleared them, so a range
 * stayed `degraded` even after the blocks came back. A signal that can only ever
 * go red is a signal people stop reading — which would have cost the alert its
 * whole purpose. This is the write half: re-index what is missing, then stamp
 * `healed_at` once the range is provably dense again.
 *
 * ── The retention floor is load-bearing ────────────────────────────────────
 * `blocks` rows are HARD-DELETED below the compact cutoff
 * (retention-cleanup.ts prunes `number < compactCutoffBlock`; BNB runs
 * COMPACT_RETENTION_DAYS=2). Measured on prod 2026-08-12: the whole `blocks`
 * table spanned 2 days 7:50, oldest row 2026-08-09 23:04.
 *
 * That makes a gap below the floor UNHEALABLE BY CONSTRUCTION — re-indexing it
 * would write rows the next retention pass deletes, and the row would sit
 * unhealed forever. So healing is deliberately bounded to the retained window:
 * `healed_at` means "no blocks are missing in the part of this range retention
 * still keeps", which is exactly the claim /api/health makes. Ranges that age
 * out below the floor stop counting on the read side rather than being marked
 * with a heal that never happened.
 *
 * ── Why it never runs while behind ─────────────────────────────────────────
 * Healing costs RPC and DB throughput. Spending either while the indexer is
 * behind pushes it toward MAX_LAG, and MAX_LAG abandons blocks — the healer
 * would manufacture the very gaps it exists to close. It only runs at the tip.
 */

/** Just the slice of the drizzle client this needs — keeps it unit-testable. */
type DbLike = { execute: (query: unknown) => Promise<unknown> }

export type HealDeps = {
  db: DbLike
  /** Re-index one block. Must throw on failure; must be idempotent on replay. */
  reindexBlock: (blockNumber: number) => Promise<void>
  /**
   * Lag in blocks (tip - lastIndexed) read from a FRESH tip. Must reject rather
   * than report a stale value — an unknown lag is treated as "behind", never as
   * "caught up", so a dead RPC cannot green-light background work.
   */
  readLag: () => Promise<number>
  /**
   * Drain the async transfer writer. Required before stamping healed_at:
   * processBlock returns once transfers are only ENQUEUED, and the MAX_LAG skip
   * already advanced the durable watermark past these blocks, so nothing else
   * can attest that the healed range's transfers actually landed.
   */
  flushTransfers?: () => Promise<void>
  now?: () => Date
  log?: (msg: string) => void
}

/** Re-read the tip every N blocks within a tick. */
export const LAG_RECHECK_EVERY = 10

export type HealOutcome =
  /** Nothing unhealed intersects the retained window. */
  | { status: 'idle' }
  /** Indexer is behind — healing deferred so it cannot deepen the lag. */
  | { status: 'skipped'; lag: number }
  /** Re-indexed some blocks; the range still has holes left for the next tick. */
  | { status: 'progressed'; fromBlock: number; toBlock: number; repaired: number }
  /** Range verified dense within the retained window; healed_at stamped. */
  | { status: 'healed'; fromBlock: number; toBlock: number; repaired: number }
  /** A block could not be re-fetched. Range left unhealed for a later tick. */
  | { status: 'failed'; fromBlock: number; toBlock: number; repaired: number; error: string }

/** Blocks re-indexed per tick. Small on purpose — this is background work. */
export const DEFAULT_HEAL_BATCH = 25

/** Max lag (blocks) that still counts as "at the tip". */
export const DEFAULT_HEAL_MAX_LAG = 50

/**
 * Positive-integer env parse that falls back instead of trusting the value.
 *
 * Every knob here fails OPEN if a bad value survives, which is the worst
 * direction for this module (codex P1):
 *   - batch 0/NaN  → `LIMIT 0` returns no missing rows, and "no rows missing" is
 *     the healed branch — a config typo would stamp healed_at over untouched
 *     damage, instantly and silently.
 *   - maxLag NaN   → `lag > NaN` is false, so the never-run-while-behind guard
 *     stops firing and the healer competes with an indexer that is losing blocks.
 *   - interval NaN → setInterval treats it as 0 and spins every tick.
 * Same shape as the config fail-open that shipped a security hole before: a bad
 * value must never mean "skip the check".
 */
export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback
  return n
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return Number(v)
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (!result) return []
  // node-postgres/drizzle return an iterable of rows; some drivers wrap in {rows}.
  const maybe = result as { rows?: unknown }
  const iterable = (maybe.rows ?? result) as Iterable<Record<string, unknown>>
  try {
    return Array.from(iterable)
  } catch {
    return []
  }
}

/**
 * The oldest unhealed gap that still intersects the retained window, already
 * clamped to the retention floor.
 *
 * `to_block >= floor` is the filter that keeps aged-out ranges out of the work
 * queue entirely — without it the healer would spin forever on a range whose
 * blocks retention deletes faster than we can write them.
 */
export const NEXT_HEALABLE_GAP_SQL = `
  WITH f AS (SELECT compact_cutoff_block AS floor FROM indexer_cursor WHERE id = 1)
  SELECT g.from_block,
         g.to_block,
         GREATEST(g.from_block, f.floor) AS heal_from,
         f.floor                          AS retention_floor
  FROM index_gaps g, f
  WHERE g.healed_at IS NULL
    AND (f.floor IS NULL OR g.to_block >= f.floor)
  ORDER BY g.from_block
  LIMIT 1
`

/**
 * Run one bounded healing tick. Returns what it did so the caller can log it.
 *
 * Deliberately does ONE range per tick: a tick that tried to drain everything
 * would hold RPC and DB capacity for as long as the damage is deep, which is
 * precisely when the indexer can least afford it.
 */
export async function healNextGap(
  deps: HealDeps,
  batchSize: number = DEFAULT_HEAL_BATCH,
  maxLag: number = DEFAULT_HEAL_MAX_LAG,
): Promise<HealOutcome> {
  const { db, reindexBlock, readLag, flushTransfers } = deps
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})

  // Re-clamp at the entry point too, not just at the env boundary. A batch of 0
  // turns the "nothing missing" branch into an instant false heal, so the value
  // must be sane no matter which caller supplied it.
  const batch = Number.isInteger(batchSize) && batchSize >= 1 ? batchSize : DEFAULT_HEAL_BATCH
  const lagCeiling = Number.isFinite(maxLag) && maxLag >= 0 ? maxLag : DEFAULT_HEAL_MAX_LAG

  // Guard FIRST: never spend RPC/DB budget on history while the tip is slipping.
  // A tip we cannot read is treated as behind — an unreachable RPC must not
  // green-light background work by defaulting to "caught up". (codex P1.)
  let lag: number
  try {
    lag = await readLag()
  } catch {
    return { status: 'skipped', lag: Number.POSITIVE_INFINITY }
  }
  if (!Number.isFinite(lag) || lag > lagCeiling) return { status: 'skipped', lag }

  const gapRow = rowsOf(await db.execute(sql.raw(NEXT_HEALABLE_GAP_SQL)))[0]
  if (!gapRow) return { status: 'idle' }

  const fromBlock = toNum(gapRow.from_block)
  const toBlock = toNum(gapRow.to_block)
  const healFrom = toNum(gapRow.heal_from)
  if (fromBlock === null || toBlock === null || healFrom === null) return { status: 'idle' }

  // What still needs work inside the retained portion of the range, oldest first.
  //
  // "Row absent" is NOT the whole test. processBlock commits the `blocks` row
  // BEFORE its transactions ("Point of no return: past here the block is
  // partially persisted"), so a mid-block failure leaves a bare row that would
  // otherwise read as proof the block is indexed — and the range would be stamped
  // healed over it. (codex P1, round 2.)
  //
  // The test is `retained transactions < blocks.tx_count`. tx_count is written in
  // the SAME insert as the block row, from block.transactions.length, so it is an
  // exact expected count rather than a proxy. An earlier cut used
  // `gas_used > 0 AND no transactions`, which only ever proved that ONE
  // transaction existed — a block that should hold 100 and holds 1 passed it.
  // (codex P1, round 3.) tx_count also handles legitimately EMPTY blocks with no
  // special case: tx_count = 0 is satisfied by zero rows.
  //
  // Safe at the retention boundary: retention deletes strictly BELOW the cutoff
  // and heal_from starts AT it, so pruned transactions are never mistaken for
  // damage.
  //
  // LIMIT lets Postgres stop once it has a batch, so the common case costs
  // O(distance to the batch-th hole) rather than O(range).
  const INCOMPLETE_IN_RANGE = sql`
    SELECT n FROM generate_series(${healFrom}::bigint, ${toBlock}::bigint) AS n
    WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.number = n)
       OR EXISTS (
            SELECT 1 FROM blocks b
            WHERE b.number = n
              AND (SELECT count(*) FROM transactions t WHERE t.block_number = n) < b.tx_count
          )
    ORDER BY n
    LIMIT ${batch}
  `
  const missing = rowsOf(await db.execute(INCOMPLETE_IN_RANGE))
    .map(r => toNum(r.n))
    .filter((n): n is number => n !== null)

  if (missing.length === 0) {
    // Drain the async transfer writer FIRST. processBlock returns once transfers
    // are merely ENQUEUED, and the MAX_LAG skip already jumped the durable
    // watermark past this range, so the watermark cannot attest to these blocks.
    // Without a flush, a crash between the block commit and the queue drain
    // leaves transfers that no restart will replay, under a gap marked healed.
    // (codex P1, round 2.)
    try {
      await flushTransfers?.()
    } catch (err) {
      log(`[gap-healer] ⚠ transfer flush failed, NOT stamping ${fromBlock}..${toBlock}: ${
        err instanceof Error ? err.message : String(err)}`)
      return { status: 'progressed', fromBlock, toBlock, repaired: 0 }
    }

    // Density is re-proved INSIDE the update, never carried across statements,
    // and `to_block` is matched so a range that grew under us is not stamped with
    // a proof that predates the growth.
    const res = await db.execute(sql`
      UPDATE index_gaps
         SET healed_at = ${now().toISOString()}::timestamptz
       WHERE from_block = ${fromBlock}
         AND to_block   = ${toBlock}
         AND healed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM generate_series(${healFrom}::bigint, ${toBlock}::bigint) AS n
           WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.number = n)
              OR EXISTS (
                   SELECT 1 FROM blocks b
                   WHERE b.number = n
                     AND (SELECT count(*) FROM transactions t WHERE t.block_number = n) < b.tx_count
                 )
         )
       RETURNING from_block
    `)
    // A conditional UPDATE that matches nothing is NOT a heal. Reporting one
    // would be the same false all-clear by a quieter route. (codex P2.)
    if (rowsOf(res).length === 0) {
      log(`[gap-healer] ${fromBlock}..${toBlock} changed under us — left unhealed`)
      return { status: 'progressed', fromBlock, toBlock, repaired: 0 }
    }
    log(`[gap-healer] healed ${fromBlock}..${toBlock} (retained window complete)`)
    return { status: 'healed', fromBlock, toBlock, repaired: 0 }
  }

  let repaired = 0
  for (let i = 0; i < missing.length; i++) {
    const blockNumber = missing[i]
    // Re-check lag from a FRESH tip periodically. A closure over a tip the poll
    // loop refreshes is useless exactly when it matters — if the live loop is
    // stuck in a slow batch while the chain advances, every check returns the
    // same stale value and the healer keeps competing. (codex P1, round 2.)
    if (i % LAG_RECHECK_EVERY === 0) {
      let midLag: number
      try {
        midLag = await readLag()
      } catch {
        // Unknown lag must not read as "caught up".
        log('[gap-healer] yielding mid-tick — could not read tip')
        return { status: 'progressed', fromBlock, toBlock, repaired }
      }
      if (!Number.isFinite(midLag) || midLag > lagCeiling) {
        log(`[gap-healer] yielding mid-tick — lag ${midLag} exceeds ${lagCeiling}`)
        return { status: 'progressed', fromBlock, toBlock, repaired }
      }
    }
    try {
      await reindexBlock(blockNumber)
      repaired++
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // Deliberately NO cleanup delete here. Removing the partial row looked like
      // a rollback but was neither safe nor reliable: once transactions exist the
      // non-cascading FK rejects it, and between this tick's absence check and
      // the delete another writer can legitimately insert the same block, so the
      // delete could destroy good data it never owned. (codex P1, round 2.)
      //
      // The partial row is caught instead by the structural-completeness test
      // above, which is idempotent, ownership-free, and durable across restarts.
      log(`[gap-healer] ⚠ block ${blockNumber} in ${fromBlock}..${toBlock} failed: ${error}`)
      // Stop this tick rather than grinding the whole batch against a bad
      // endpoint; the range stays unhealed and the next tick retries it.
      return { status: 'failed', fromBlock, toBlock, repaired, error }
    }
  }

  log(`[gap-healer] repaired ${repaired} block(s) in ${fromBlock}..${toBlock}`)
  return { status: 'progressed', fromBlock, toBlock, repaired }
}
