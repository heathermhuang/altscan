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
   * Identity of THIS process, used as the lease's fencing token. Must be unique
   * per process — two generations sharing an owner string would defeat the lease
   * entirely during a rolling deploy, which is the exact window it guards.
   */
  owner: string
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

/**
 * How long a claimed gap stays leased. Must comfortably exceed one tick's work
 * (a batch of blocks plus the transfer flush) so the holder finishes long before
 * the lease lapses, while staying short enough that a crashed holder does not
 * park a gap for long.
 */
export const DEFAULT_HEAL_LEASE_MS = 600_000

/** Stop this many ms before the lease lapses, so work never outlives the claim. */
export const LEASE_SAFETY_MS = 30_000

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
  leaseMsIn: number = DEFAULT_HEAL_LEASE_MS,
): Promise<HealOutcome> {
  const { db, reindexBlock, readLag, flushTransfers, owner } = deps
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})

  // Re-clamp at the entry point too, not just at the env boundary. A batch of 0
  // turns the "nothing missing" branch into an instant false heal, so the value
  // must be sane no matter which caller supplied it.
  const batch = Number.isInteger(batchSize) && batchSize >= 1 ? batchSize : DEFAULT_HEAL_BATCH
  const lagCeiling = Number.isFinite(maxLag) && maxLag >= 0 ? maxLag : DEFAULT_HEAL_MAX_LAG
  // The lease must outlast a tick by a wide margin, or the safety margin below
  // would abort every tick immediately.
  const leaseMs = Number.isInteger(leaseMsIn) && leaseMsIn > LEASE_SAFETY_MS * 2
    ? leaseMsIn : DEFAULT_HEAL_LEASE_MS

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

  // Claim atomically. No row means another process (or another generation mid
  // rolling deploy) holds the lease — idle rather than racing it.
  const gapRow = rowsOf(await db.execute(sql`
    WITH f AS (SELECT compact_cutoff_block AS floor FROM indexer_cursor WHERE id = 1),
         candidate AS (
           -- Deliberately does NOT skip leased rows. Skipping would let a second
           -- process move on to the NEXT row — and gap ranges can OVERLAP, because
           -- a reorg rollback moves lastIndexed backwards so a later skip can
           -- record a range overlapping a stored one. A would hold [100,200] while
           -- B claimed [110,250], and both would see 110..124 as absent and call
           -- processBlock on them. The per-row lease cannot see that; the rows
           -- differ. (codex P1, round 9.)
           --
           -- Nominating the oldest row unconditionally means every process
           -- competes for the SAME row, so the repeated target predicate below
           -- leaves exactly one winner and idles the rest. Only one gap is in
           -- flight at a time, which is fine for a background trickle and is the
           -- only way to make overlap impossible rather than merely unlikely.
           SELECT g.from_block
           FROM index_gaps g, f
           WHERE g.healed_at IS NULL
             AND (f.floor IS NULL OR g.to_block >= f.floor)
           ORDER BY g.from_block
           LIMIT 1
         )
    UPDATE index_gaps g
       SET heal_lease_owner = ${owner},
           heal_lease_until = now() + (${leaseMs} || ' milliseconds')::interval
      FROM f
     WHERE g.from_block = (SELECT from_block FROM candidate)
       -- Eligibility is REPEATED here, not just inside the candidate CTE, and
       -- that is what makes the claim atomic. Under READ COMMITTED two claimers
       -- can both pick row 100; the second blocks on the row lock and, once the
       -- first commits, Postgres RE-EVALUATES this predicate against the new row
       -- version. With only from_block = 100 it still passes, so the loser would
       -- overwrite the winner's lease and also be handed the gap — both then enter
       -- processBlock, and no amount of later fencing can un-duplicate a dex_trade
       -- or un-send a webhook. Re-checking the lease here makes the loser update
       -- zero rows and idle. (codex P1, round 8.)
       AND g.healed_at IS NULL
       AND (g.heal_lease_until IS NULL OR g.heal_lease_until < now())
    RETURNING g.from_block,
              g.to_block,
              GREATEST(g.from_block, f.floor, COALESCE(g.heal_cursor + 1, g.from_block)) AS heal_from,
              GREATEST(g.from_block, f.floor) AS verify_from,
              g.heal_cursor AS heal_cursor,
              f.floor       AS retention_floor
  `))[0]
  if (!gapRow) return { status: 'idle' }
  // Local deadline: stop before the lease lapses so a slow tick cannot still be
  // calling processBlock while another owner has taken over.
  const leaseDeadline = Date.now() + leaseMs

  const fromBlock = toNum(gapRow.from_block)
  const toBlock = toNum(gapRow.to_block)
  const healFrom = toNum(gapRow.heal_from)
  const verifyFrom = toNum(gapRow.verify_from)
  if (fromBlock === null || toBlock === null || healFrom === null || verifyFrom === null) {
    return { status: 'idle' }
  }

  // Work one WINDOW at a time, bounded by a DURABLE cursor.
  //
  // The cursor is what makes healing crash-safe. processBlock only ENQUEUES
  // transfers before returning, and the async writer's queue lives in memory, so
  // a crash after re-indexing but before the drain loses those transfers — and
  // no restart replays them, because the MAX_LAG skip already jumped the durable
  // watermark past this range. The block itself survives with a full tx_count,
  // so every content-based test would call it complete. (codex P1, round 3.)
  //
  // heal_cursor only ever advances past blocks that have been re-indexed, had the
  // transfer queue DRAINED, and then re-verified. A crash anywhere earlier leaves
  // the cursor behind, so the whole window is redone; processBlock is idempotent,
  // so redoing it is free of consequence.
  const windowEnd = Math.min(toBlock, healFrom + batch - 1)

  // Content test for the window. `retained transactions < blocks.tx_count` uses
  // the exact count written in the SAME insert as the block row, so a block that
  // should hold 100 transactions and holds 1 is caught — the earlier
  // `gas_used > 0 AND no transactions` proxy only ever proved that ONE existed.
  // tx_count = 0 covers legitimately empty blocks with no special case.
  //
  // Safe at the retention boundary: retention deletes strictly BELOW the cutoff
  // and heal_from starts AT it, so pruned transactions are never read as damage.
  const incompleteIn = (lo: number, hi: number) => sql`
    SELECT n FROM generate_series(${lo}::bigint, ${hi}::bigint) AS n
    WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.number = n)
       OR EXISTS (
            SELECT 1 FROM blocks b
            WHERE b.number = n
              AND (SELECT count(*) FROM transactions t WHERE t.block_number = n) <> b.tx_count
          )
    ORDER BY n
  `
  // Work set = ABSENT blocks ONLY. Nothing else is safe to process.
  //
  // processBlock is not a repair tool, it is a first-time indexer, and it has no
  // partial mode: it decodes EVERY receipt in the block and re-runs every side
  // effect. So re-processing a block that already exists —
  //   - inserts all its dex_trades AGAIN (`id serial PRIMARY KEY`, no unique
  //     constraint, so onConflictDoNothing() cannot dedupe; rpc-failover.ts:70
  //     documents this and refuses to fail over past a side effect for it),
  //   - re-delivers webhooks for every transaction, not just new ones, and
  //   - DELETEs and re-inserts the block's transfers, which destroys good rows
  //     outright if the receipt fetch comes back empty (null is read as []).
  // An earlier cut selected blocks with `transactions < tx_count`, reasoning that
  // "underfull" damage is repairable. It is not: the missing transaction may be
  // unreinsertable (a mixed-fork hash collision), in which case the predicate
  // stays true and those side effects repeat EVERY tick — unbounded duplication.
  // (codex P1, rounds 5 and 6.)
  //
  // An ABSENT block has no transactions, no dex_trades, no transfers and no
  // delivered webhooks, so indexing it is a first write rather than a replay.
  // That is also exactly the damage a MAX_LAG skip produces: whole abandoned
  // blocks. The healer therefore covers its actual use case completely.
  //
  // Present-but-wrong blocks (underfull OR overfull) are deliberately left alone.
  // Verification below uses exact equality, so such a block holds its range
  // unhealed and loudly logged — visibly degraded, which is honest, rather than
  // silently stamped or endlessly reprocessed. Repairing them needs a
  // transactional block rebuild, which is a separate piece of work.
  const missing = rowsOf(await db.execute(sql`
    SELECT n FROM generate_series(${healFrom}::bigint, ${windowEnd}::bigint) AS n
    WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.number = n)
    ORDER BY n
  `))
    .map(r => toNum(r.n))
    .filter((n): n is number => n !== null)

  let repaired = 0
  for (let i = 0; i < missing.length; i++) {
    const blockNumber = missing[i]
    // Re-check lag from a FRESH tip periodically. A closure over a tip the poll
    // loop refreshes is useless exactly when it matters — if the live loop is
    // stuck in a slow batch while the chain advances, every check returns the
    // same stale value and the healer keeps competing. (codex P1, round 2.)
    // Bail before the lease lapses. Past that point another generation may hold
    // the gap, and two processBlock runs on one block is the corruption this
    // lease exists to prevent.
    if (Date.now() > leaseDeadline - LEASE_SAFETY_MS) {
      log(`[gap-healer] lease expiring — stopping after ${repaired} block(s) in ${fromBlock}..${toBlock}`)
      return { status: 'progressed', fromBlock, toBlock, repaired }
    }
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

  // Drain BEFORE confirming anything. Until the queue is on disk, these blocks
  // are not durable no matter how complete they look.
  try {
    await flushTransfers?.()
  } catch (err) {
    log(`[gap-healer] ⚠ transfer flush failed, NOT advancing ${fromBlock}..${toBlock}: ${
      err instanceof Error ? err.message : String(err)}`)
    return { status: 'progressed', fromBlock, toBlock, repaired }
  }

  // Re-verify the window now that everything is durable. Only then is the cursor
  // allowed past it.
  const bad = rowsOf(await db.execute(incompleteIn(healFrom, windowEnd)))
  if (bad.length > 0) {
    // Exact-equality verification, so this also catches OVERFULL blocks that the
    // work set deliberately skipped. Those cannot be repaired by replay, so say so
    // loudly: the range stays unhealed and visible rather than quietly retried
    // forever or silently stamped.
    log(`[gap-healer] ${bad.length} block(s) failed verification in ${healFrom}..${windowEnd} — cursor held, range left degraded`)
    return { status: 'progressed', fromBlock, toBlock, repaired }
  }

  await db.execute(sql`
    UPDATE index_gaps
       SET heal_cursor = GREATEST(COALESCE(heal_cursor, ${healFrom} - 1), ${windowEnd})
     WHERE from_block = ${fromBlock} AND healed_at IS NULL
       -- Fenced: a lapsed owner must not land a late write over the new owner.
       AND heal_lease_owner = ${owner} AND heal_lease_until > now()
  `)

  if (windowEnd < toBlock) {
    log(`[gap-healer] repaired ${repaired} block(s); confirmed through ${windowEnd} of ${fromBlock}..${toBlock}`)
    return { status: 'progressed', fromBlock, toBlock, repaired }
  }

  // Whole range confirmed. Stamp in ONE statement that re-proves density, so a
  // reorg or a range that grew under us cannot receive a stale proof.
  const res = await db.execute(sql`
    UPDATE index_gaps
       SET healed_at = ${now().toISOString()}::timestamptz
     WHERE from_block = ${fromBlock}
       AND to_block   = ${toBlock}
       AND healed_at IS NULL
       AND heal_lease_owner = ${owner} AND heal_lease_until > now()
       AND NOT EXISTS (
         SELECT 1 FROM generate_series(${verifyFrom}::bigint, ${toBlock}::bigint) AS n
         WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.number = n)
            OR EXISTS (
                 SELECT 1 FROM blocks b
                 WHERE b.number = n
                   AND (SELECT count(*) FROM transactions t WHERE t.block_number = n) <> b.tx_count
               )
       )
     RETURNING from_block
  `)
  // A conditional UPDATE that matches nothing is NOT a heal. (codex P2.)
  if (rowsOf(res).length === 0) {
    log(`[gap-healer] ${fromBlock}..${toBlock} changed under us — left unhealed`)
    return { status: 'progressed', fromBlock, toBlock, repaired }
  }
  log(`[gap-healer] healed ${fromBlock}..${toBlock} (retained window complete)`)
  return { status: 'healed', fromBlock, toBlock, repaired }
}
