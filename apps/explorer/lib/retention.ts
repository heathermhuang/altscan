import { db } from './db'
import { sql } from 'drizzle-orm'
import { swallow } from './observability'

/**
 * Detects whether the local index is missing transaction/transfer history for an
 * address (so the page should serve full Moralis history instead of a partial
 * local slice with bogus pagination — e.g. heatherm.eth: 118 lifetime txns, 1 row
 * retained, "Page 1 of 5" with pages 2-5 empty).
 *
 * Why first_seen is an exact signal:
 *   - The indexer prunes high-volume tables (transactions, token_transfers, …) to a
 *     rolling RETENTION_DAYS window (see apps/indexer/src/retention-cleanup.ts).
 *   - It NEVER prunes the addresses table, and addresses.first_seen is written only
 *     on INSERT (block-processor.ts), so it's the frozen timestamp of the address's
 *     FIRST indexed tx — it survives long after that tx's row is deleted.
 *   - Therefore first_seen < (oldest retained block) ⟺ the earliest indexed tx (and
 *     usually more) has been pruned ⟺ the local tables hold only a recent slice.
 *
 * A fully-indexed active wallet has first_seen within the retention window
 * (first_seen >= floor) → returns false → it keeps the fast local path with no
 * extra Moralis calls. Unknown inputs (null first_seen or null floor) return false
 * so we degrade to the prior empty-only fallback and never over-call Moralis on a
 * transient DB error.
 *
 * Pure function: the floor is fetched separately via getRetentionFloor().
 */
export function isLocalHistoryIncomplete(
  firstSeen: Date | null | undefined,
  retentionFloor: Date | null,
): boolean {
  if (!firstSeen || !retentionFloor) return false
  return firstSeen.getTime() < retentionFloor.getTime()
}

/**
 * The retention floor: the time of the first block at or above
 * indexer_cursor.compact_cutoff_block, the boundary retention publishes and then
 * deletes below (apps/indexer/src/retention-cleanup.ts). /api/health reports the
 * same cutoff.
 *
 * NOT MIN(blocks.timestamp). Retention publishes the cutoff BEFORE it deletes and
 * deletes `blocks` last, so for a whole prune (25-70 min on BNB) the oldest block
 * row is older than the transactions that survive, and a block row the prune
 * skips pins it there. A floor inferred from the rows being measured is circular:
 * it reported "complete" for addresses whose earliest rows were already gone.
 * Not cached for the same reason: a cached floor is the old cutoff while the new
 * one is being deleted below. It is two primary-key lookups.
 *
 * Returns null when no cutoff has been published (retention never ran, or
 * compact pruning is off) or the query fails. Callers treat null as "unknown"
 * via isLocalHistoryIncomplete() and fall back to prior behavior.
 */
export async function getRetentionFloor(): Promise<Date | null> {
  return (await getRetentionCutoff())?.floor ?? null
}

/**
 * The retention floor as a block too: the first block at or above the published
 * cutoff, and its time. A read bounded below by both never walks into the rows a
 * prune is deleting, whichever index serves it, and the two agree on which rows
 * that is: blocks below the cutoff can share the floor's second.
 */
export async function getRetentionCutoff(): Promise<{ block: number; floor: Date } | null> {
  try {
    const result = await db.execute(sql`
      SELECT number AS block, timestamp AS floor FROM blocks
      WHERE number >= (SELECT compact_cutoff_block FROM indexer_cursor WHERE id = 1)
      ORDER BY number
      LIMIT 1
    `)
    const row = Array.from(result)[0] as Record<string, unknown> | undefined
    return row?.floor ? { block: Number(row.block), floor: new Date(row.floor as string | number | Date) } : null
  } catch (e) {
    swallow('retention/floor', e)
    return null
  }
}
