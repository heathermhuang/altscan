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
  /** Current lag in blocks (tip - lastIndexed). Healing is skipped when behind. */
  lagBlocks: () => number
  now?: () => Date
  log?: (msg: string) => void
}

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
  const { db, reindexBlock, lagBlocks } = deps
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})

  // Re-clamp at the entry point too, not just at the env boundary. A batch of 0
  // turns the "nothing missing" branch into an instant false heal, so the value
  // must be sane no matter which caller supplied it.
  const batch = Number.isInteger(batchSize) && batchSize >= 1 ? batchSize : DEFAULT_HEAL_BATCH
  const lagCeiling = Number.isFinite(maxLag) && maxLag >= 0 ? maxLag : DEFAULT_HEAL_MAX_LAG

  const lag = lagBlocks()
  // Guard FIRST: never spend RPC/DB budget on history while the tip is slipping.
  if (!Number.isFinite(lag) || lag > lagCeiling) return { status: 'skipped', lag }

  const gapRow = rowsOf(await db.execute(sql.raw(NEXT_HEALABLE_GAP_SQL)))[0]
  if (!gapRow) return { status: 'idle' }

  const fromBlock = toNum(gapRow.from_block)
  const toBlock = toNum(gapRow.to_block)
  const healFrom = toNum(gapRow.heal_from)
  if (fromBlock === null || toBlock === null || healFrom === null) return { status: 'idle' }

  // Missing blocks inside the retained portion of the range, oldest first.
  // LIMIT lets Postgres stop as soon as it has a batch, so the common case costs
  // O(distance to the batch-th hole) rather than O(range).
  const missing = rowsOf(await db.execute(sql`
    SELECT n FROM generate_series(${healFrom}::bigint, ${toBlock}::bigint) AS n
    WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.number = n)
    ORDER BY n
    LIMIT ${batch}
  `))
    .map(r => toNum(r.n))
    .filter((n): n is number => n !== null)

  if (missing.length === 0) {
    // Density is re-proved INSIDE the update, never assumed and never carried
    // across statements. A no-op result means the range changed under us, which
    // simply leaves it unhealed for the next tick.
    await db.execute(sql`
      UPDATE index_gaps
         SET healed_at = ${now().toISOString()}::timestamptz
       WHERE from_block = ${fromBlock}
         AND to_block   = ${toBlock}
         AND healed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM generate_series(${healFrom}::bigint, ${toBlock}::bigint) AS n
           WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.number = n)
         )
    `)
    log(`[gap-healer] healed ${fromBlock}..${toBlock} (retained window complete)`)
    return { status: 'healed', fromBlock, toBlock, repaired: 0 }
  }

  let repaired = 0
  for (const blockNumber of missing) {
    // Re-check lag between blocks. The tip moves while a tick runs, so a single
    // check at the start can leave the healer competing with a loop that has
    // since fallen behind. (codex P1.)
    const midLag = lagBlocks()
    if (!Number.isFinite(midLag) || midLag > lagCeiling) {
      log(`[gap-healer] yielding mid-tick — lag ${midLag} exceeds ${lagCeiling}`)
      return { status: 'progressed', fromBlock, toBlock, repaired }
    }
    try {
      await reindexBlock(blockNumber)
      repaired++
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // Roll back the partial write. processBlock inserts the `blocks` row FIRST
      // and its transactions after ("Point of no return: past here the block is
      // partially persisted"), so a mid-block failure leaves a bare block row.
      // That row would read as proof the block is indexed, and the next tick
      // would skip it and stamp healed_at over an incomplete block. (codex P1.)
      //
      // Safe to delete: this tick's own query proved the block ABSENT moments
      // ago, so removing it restores the state we found rather than destroying
      // anything that predates us.
      try {
        await db.execute(sql`DELETE FROM blocks WHERE number = ${blockNumber}`)
      } catch (cleanupErr) {
        // Leave the range unhealed and say so — a bare row that survives here is
        // exactly the silent-completeness bug, so it must not pass unremarked.
        log(`[gap-healer] ⚠ could NOT roll back partial block ${blockNumber}: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
      }
      log(`[gap-healer] ⚠ block ${blockNumber} in ${fromBlock}..${toBlock} failed: ${error}`)
      // Stop this tick rather than grinding the whole batch against a bad
      // endpoint; the range stays unhealed and the next tick retries it.
      return { status: 'failed', fromBlock, toBlock, repaired, error }
    }
  }

  log(`[gap-healer] repaired ${repaired} block(s) in ${fromBlock}..${toBlock}`)
  return { status: 'progressed', fromBlock, toBlock, repaired }
}
