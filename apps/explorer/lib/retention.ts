import { db } from './db'
import { sql } from 'drizzle-orm'

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
 * Pure function: the floor is fetched separately (and cached) via getRetentionFloor().
 */
export function isLocalHistoryIncomplete(
  firstSeen: Date | null | undefined,
  retentionFloor: Date | null,
): boolean {
  if (!firstSeen || !retentionFloor) return false
  return firstSeen.getTime() < retentionFloor.getTime()
}

// The retention floor advances slowly (cleanup runs every 6h), so cache it rather
// than running a MIN() on every address-page request. Module-level cache is
// per-instance and that's fine — each instance refreshes independently.
let floorCache: { value: Date | null; at: number } | null = null
const FLOOR_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * The retention floor = MIN(blocks.timestamp) = the timestamp of the oldest block
 * still in the local index.
 *
 * Derived from live data rather than a hardcoded RETENTION_DAYS because retention
 * is chain-specific and drifts during incidents (it has been tightened under disk
 * pressure). Backed by blocks_timestamp_idx, so MIN() is a fast leftmost-index
 * lookup. Cached for FLOOR_TTL_MS.
 *
 * Returns null if the blocks table is empty or the query fails — callers treat
 * null as "unknown" via isLocalHistoryIncomplete() and fall back to prior behavior.
 */
export async function getRetentionFloor(now: number = Date.now()): Promise<Date | null> {
  if (floorCache && now - floorCache.at < FLOOR_TTL_MS) return floorCache.value
  try {
    const result = await db.execute(sql`SELECT MIN(timestamp) AS floor FROM blocks`)
    const row = Array.from(result)[0] as Record<string, unknown> | undefined
    const raw = row?.floor
    const value = raw ? new Date(raw as string | number | Date) : null
    floorCache = { value, at: now }
    return value
  } catch {
    // Reuse the last-known floor on a transient error; null if we never succeeded.
    return floorCache?.value ?? null
  }
}
