/**
 * The hourly series behind /charts when a chain has fewer than three whole UTC days to draw (BNB keeps
 * about two days of blocks). One aggregate over `blocks`, filtered to the last HOURLY_WINDOW_HOURS and
 * cached (lib/page-cache.ts): the three series (transactions, average base fee, blocks) come out of the
 * same scan, so the page pays for one query, not three. The scan is bounded by that window and by the
 * fallback itself, which only runs when the table holds under about four days of blocks; on that data
 * Postgres seq-scans the table and hash-aggregates it (it does not need blocks_timestamp_idx).
 */
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { createPageCache } from '@/lib/page-cache'
import { withTimeout } from '@/lib/with-timeout'
import { toHourRow, type HourRow } from '@/lib/chart-hours'

/** Equals `export const revalidate` in app/charts/page.tsx (Next needs that one as a literal). */
export const CHARTS_HOURLY_REVALIDATE_SECONDS = 300

/**
 * How far back the query reads. The fallback applies only under three whole UTC days, which is at
 * most about four days of blocks (a partial first day, two whole days, today). The query reads the
 * last 72 hours of that, so it is bounded and the chart is "last N h" for N up to 71.
 */
export const HOURLY_WINDOW_HOURS = 72

export function hourlyChartQuery() {
  // The GROUP BY is on the truncated timestamp itself and the epoch is taken after it: grouping by
  // EXTRACT(EPOCH FROM date_trunc(...)) made the planner sort all ~400k rows through a 13 MB disk
  // spill (212 ms); grouping by the timestamp hash-aggregates them (115 ms, no spill).
  return sql`
    SELECT EXTRACT(EPOCH FROM h.hour) AS hour_ts, h.tx, h.blocks, h.gas, h.first_ts
    FROM (
      SELECT date_trunc('hour', b.timestamp AT TIME ZONE 'UTC') AS hour,
             SUM(b.tx_count)::int AS tx,
             COUNT(*)::int AS blocks,
             (AVG(b.base_fee_per_gas / 1e9) FILTER (WHERE b.base_fee_per_gas > 0))::numeric(18,4) AS gas,
             EXTRACT(EPOCH FROM MIN(b.timestamp)) AS first_ts
      FROM blocks b
      WHERE b.timestamp >= NOW() - make_interval(hours => ${HOURLY_WINDOW_HOURS}::int)
      GROUP BY 1
    ) h
    ORDER BY 1
  `
}

/**
 * `asOf` is when the query ran (epoch ms): which hour was still in progress is a fact about that
 * moment, not about the later render the cached rows are served to.
 */
export type HourlyChart = { asOf: number; rows: HourRow[] }

/** THROWS on a failed or timed-out query, so the cache around it never stores a failure. */
export async function queryHourlyChart(): Promise<HourlyChart> {
  const result = await withTimeout(db.execute(hourlyChartQuery()))
  return { asOf: Date.now(), rows: Array.from(result).map(toHourRow) }
}

/** Named once, at module scope; a change to the value's shape needs a new name (see createPageCache). */
export const fetchHourlyChart = createPageCache('charts-hourly', CHARTS_HOURLY_REVALIDATE_SECONDS, queryHourlyChart)
