/**
 * Index completeness reporting.
 *
 * The indexer abandons blocks on purpose when it falls too far behind
 * (`MAX_LAG_BLOCKS`), and until #94 recorded nothing when it did. Between
 * 2026-08-04 and 08-11 that silently dropped ~92,000 blocks while /api/health
 * reported `{"status":"ok"}` throughout — `status` degraded only on memory
 * pressure, and `latestBlock` is max(blocks.number), which sits frozen during a
 * gap backfill (so `lagSeconds` read 14,396s while the indexer was healthy).
 *
 * The indexer writes each abandoned range to `index_gaps` and now heals them
 * (gap-healer.ts); this is the read half. Completeness is reported separately
 * from liveness, because they fail independently — the whole incident was a
 * live, responsive indexer losing data.
 *
 * ── Bounded by the retention floor ─────────────────────────────────────────
 * `blocks` rows are hard-deleted below the compact cutoff, so on BNB the table
 * only holds ~2 days (measured 2026-08-12: 2d 07:50, oldest row 08-09 23:04).
 * A gap below that floor describes blocks retention deleted ON PURPOSE — it is
 * policy, not damage, and it can never be healed because a backfill would just
 * be pruned again. Counting it would pin the signal red forever, and a signal
 * that can only go red is one people stop reading.
 *
 * So the reported claim is bounded from BOTH ends: `ok` means "no recorded gaps
 * at or after `trackedFromBlock`", where that bound is the LATER of where gap
 * recording began and where retention currently starts. Both bounds only ever
 * narrow the claim; neither can manufacture one.
 */

export type GapSummary = {
  /** Unhealed gap ranges intersecting the retained window, overlaps merged. */
  count: number
  /** Total blocks missing across those ranges. */
  missingBlocks: number
  /** Lowest abandoned block still unhealed, for locating the oldest damage. */
  oldestFromBlock: number | null
  /**
   * The block at or above which `ok` actually holds — the later of where gap
   * RECORDING began and where RETENTION currently starts.
   *
   * Coverage before the recording baseline was never tracked, so "no gaps" says
   * nothing about it (codex P1 on #94). Coverage below the retention floor is
   * intentionally absent. NULL means the claim is unverifiable, which reports
   * `unverified` rather than `ok`.
   */
  trackedFromBlock: number | null
  /** Lowest block retention still keeps. Exposed so the bound is auditable. */
  retentionFloorBlock: number | null
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
  if (!row) {
    return {
      count: 0,
      missingBlocks: 0,
      oldestFromBlock: null,
      trackedFromBlock: null,
      retentionFloorBlock: null,
    }
  }
  return {
    count: toCount(row.gap_count),
    missingBlocks: toCount(row.missing_blocks),
    oldestFromBlock: toBlock(row.oldest_from),
    trackedFromBlock: toBlock(row.tracked_from),
    retentionFloorBlock: toBlock(row.retention_floor),
  }
}

/**
 * ONE unhealed gap degrades. Deliberately not thresholded on block count: the
 * failure mode being guarded against produced ~5,100 missing blocks an hour, and
 * any threshold above zero would have stayed green for the first hour of it.
 *
 * `unverified` is NOT `ok`. An empty table means "nothing recorded", which is
 * indistinguishable from "never tracked" unless we know where tracking started.
 * `ok` therefore means the bounded claim "no recorded gaps at or after
 * trackedFromBlock". (codex P1.)
 */
export function completenessStatus(summary: GapSummary): 'ok' | 'degraded' | 'unverified' {
  if (summary.count > 0) return 'degraded'
  return summary.trackedFromBlock === null ? 'unverified' : 'ok'
}

/**
 * The single SQL read behind the summary. Kept here so both halves stay in step.
 *
 * Three things it must get right:
 *
 * 1. CLAMP to the retention floor, and drop ranges entirely below it. Those are
 *    unhealable by construction (see the header) and would pin `degraded` on.
 *
 * 2. MERGE overlapping ranges before summing. Normal skips cannot overlap, but a
 *    reorg rollback moves `lastIndexed` BACKWARDS, so the next skip can record a
 *    range that overlaps one already stored. Summing the raw rows then
 *    double-counts blocks and reports more damage than exists. `gapCount` and the
 *    degrade decision were always right; only the total inflated.
 *
 * 3. FAIL CLOSED. If the cursor row is missing, or `blocks` is empty (no floor),
 *    `tracked_from` is NULL and the status is `unverified` — never `ok`.
 */
export const GAP_SUMMARY_SQL = `
  WITH f AS (SELECT MIN(number) AS floor FROM blocks),
       t AS (SELECT gap_tracking_from_block AS tracked FROM indexer_cursor WHERE id = 1),
       clamped AS (
         SELECT GREATEST(g.from_block, f.floor) AS from_block, g.to_block
         FROM index_gaps g, f
         WHERE g.healed_at IS NULL
           AND f.floor IS NOT NULL
           AND g.to_block >= f.floor
       ),
       ordered AS (
         SELECT from_block, to_block,
                MAX(to_block) OVER (
                  ORDER BY from_block, to_block
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS prev_max
         FROM clamped
       ),
       marked AS (
         SELECT from_block, to_block,
                COUNT(*) FILTER (WHERE prev_max IS NULL OR from_block > prev_max + 1)
                  OVER (ORDER BY from_block, to_block ROWS UNBOUNDED PRECEDING) AS grp
         FROM ordered
       ),
       merged AS (
         SELECT MIN(from_block) AS from_block, MAX(to_block) AS to_block
         FROM marked GROUP BY grp
       )
  SELECT (SELECT COUNT(*) FROM merged)                                          AS gap_count,
         (SELECT COALESCE(SUM(to_block - from_block + 1), 0) FROM merged)        AS missing_blocks,
         (SELECT MIN(from_block) FROM merged)                                    AS oldest_from,
         (SELECT floor FROM f)                                                   AS retention_floor,
         (SELECT CASE WHEN t.tracked IS NULL OR f.floor IS NULL THEN NULL
                      ELSE GREATEST(t.tracked, f.floor) END
            FROM t, f)                                                           AS tracked_from
`
