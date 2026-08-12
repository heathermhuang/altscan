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
  WITH f AS (SELECT MIN(number) AS floor FROM blocks)
  SELECT g.from_block,
         g.to_block,
         GREATEST(g.from_block, f.floor) AS heal_from,
         f.floor                          AS retention_floor
  FROM index_gaps g, f
  WHERE g.healed_at IS NULL
    AND f.floor IS NOT NULL
    AND g.to_block >= f.floor
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

  const lag = lagBlocks()
  // Guard FIRST: never spend RPC/DB budget on history while the tip is slipping.
  if (!Number.isFinite(lag) || lag > maxLag) return { status: 'skipped', lag }

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
    LIMIT ${batchSize}
  `))
    .map(r => toNum(r.n))
    .filter((n): n is number => n !== null)

  if (missing.length === 0) {
    // Verified dense across the retained window — NOT assumed. healed_at is only
    // ever stamped off a fresh read proving there is nothing left to fetch.
    await db.execute(sql`
      UPDATE index_gaps SET healed_at = ${now().toISOString()}::timestamptz
      WHERE from_block = ${fromBlock} AND healed_at IS NULL
    `)
    log(`[gap-healer] healed ${fromBlock}..${toBlock} (retained window complete)`)
    return { status: 'healed', fromBlock, toBlock, repaired: 0 }
  }

  let repaired = 0
  for (const blockNumber of missing) {
    try {
      await reindexBlock(blockNumber)
      repaired++
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log(`[gap-healer] ⚠ block ${blockNumber} in ${fromBlock}..${toBlock} failed: ${error}`)
      // Stop this tick rather than grinding the whole batch against a bad
      // endpoint; the range stays unhealed and the next tick retries it.
      return { status: 'failed', fromBlock, toBlock, repaired, error }
    }
  }

  log(`[gap-healer] repaired ${repaired} block(s) in ${fromBlock}..${toBlock}`)
  return { status: 'progressed', fromBlock, toBlock, repaired }
}
