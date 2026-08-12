/**
 * Index completeness reporting.
 *
 * The indexer abandons blocks on purpose when it falls too far behind
 * (`MAX_LAG_BLOCKS`), and until now recorded nothing when it did. Between
 * 2026-08-04 and 08-11 that silently dropped ~92,000 blocks while /api/health
 * reported `{"status":"ok"}` throughout — `status` degraded only on memory
 * pressure, and `latestBlock` is max(blocks.number), which sits frozen during a
 * gap backfill (so `lagSeconds` read 14,396s while the indexer was healthy).
 *
 * The indexer now writes each abandoned range to `index_gaps`; this is the read
 * half. Completeness is reported separately from liveness, because they fail
 * independently — the whole incident was a live, responsive indexer losing data.
 */

export type GapSummary = {
  /** Unhealed gap ranges. */
  count: number
  /** Total blocks missing across those ranges. */
  missingBlocks: number
  /** Lowest abandoned block still unhealed, for locating the oldest damage. */
  oldestFromBlock: number | null
}

/**
 * node-postgres returns COUNT/SUM/MIN over BIGINT as STRINGS, so every field
 * here is coerced rather than trusted. Reading them raw gives string
 * concatenation on arithmetic and a truthy `"0"`.
 */
function toCount(v: unknown): number {
  if (typeof v === 'bigint') return Number(v)
  const n = Number(v)
  // NaN (nonsense/undefined) and negatives both collapse to 0 — a broken read
  // must never invent damage, nor mask it with a negative.
  return Number.isFinite(n) && n > 0 ? n : 0
}

function toBlock(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return Number(v)
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function summarizeGapRow(row: Record<string, unknown> | undefined | null): GapSummary {
  if (!row) return { count: 0, missingBlocks: 0, oldestFromBlock: null }
  return {
    count: toCount(row.gap_count),
    missingBlocks: toCount(row.missing_blocks),
    oldestFromBlock: toBlock(row.oldest_from),
  }
}

/**
 * ONE unhealed gap degrades. Deliberately not thresholded on block count: the
 * failure mode being guarded against produced ~5,100 missing blocks an hour, and
 * any threshold above zero would have stayed green for the first hour of it.
 */
export function completenessStatus(summary: GapSummary): 'ok' | 'degraded' {
  return summary.count > 0 ? 'degraded' : 'ok'
}

/** The single SQL read behind the summary. Kept here so both halves stay in step. */
export const GAP_SUMMARY_SQL = `
  SELECT COUNT(*)                                  AS gap_count,
         SUM(to_block - from_block + 1)            AS missing_blocks,
         MIN(from_block)                           AS oldest_from
  FROM index_gaps
  WHERE healed_at IS NULL
`
