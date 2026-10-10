/**
 * Which hours of an hourly series /charts may plot, for a chain that has fewer than three whole UTC
 * days to draw (BNB keeps about two days of blocks). The rule is lib/chart-days.ts's, on the hour:
 * a bucket that is not whole reads as a collapse, so the hour in progress and a first hour the
 * index only caught the end of are not plotted.
 */

export const HOUR_MS = 3_600_000

/**
 * How far after the hour start the first hour's earliest block may land and still count as a whole
 * hour. Judged from the data, as the day is: the first hour is whole only if its earliest block is at
 * the start of the hour (a block lands every 0.45 s on BNB, 12 s on ETH). 5 minutes leaves room for
 * an indexer restart or RPC failover at the boundary.
 */
export const FIRST_HOUR_TOLERANCE_MS = 5 * 60_000

/** The fewest whole hours worth a chart; under it /charts keeps the block tape. */
export const MIN_HOURS = 6

/** One hour of the hourly query, as plain numbers (no BigInt, no Date), so it survives JSON in the page cache. */
export type HourRow = {
  /** Epoch ms of the hour's start (00 minutes UTC). */
  hourMs: number
  /** Epoch ms of the hour's earliest block; NaN when unknown. */
  firstTs: number
  tx: number
  blocks: number
  /** Average base fee in Gwei over the hour's blocks that have one; null when none do. */
  gas: number | null
}

/**
 * `hours` (ascending, one row per UTC hour) without the hour `now` falls in and, when the series
 * starts mid-hour, without its first hour. `now` is a parameter so the cut is testable.
 */
export function completeUtcHours<T extends { hourMs: number; firstTs: number }>(hours: readonly T[], now: Date): T[] {
  const currentHour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS
  const past = hours.filter(h => h.hourMs < currentHour)
  const first = past[0]
  // Written so an unknown start fails the test and the hour is dropped, never plotted as whole. NaN does,
  // and so does the null it becomes in the page cache's JSON (null - hourMs would read as "starts early").
  const startsWithTheHour = first !== undefined && Number.isFinite(first.firstTs) && first.firstTs - first.hourMs <= FIRST_HOUR_TOLERANCE_MS
  return first === undefined || startsWithTheHour ? past : past.slice(1)
}

/**
 * A row of the hourly GROUP BY: `hour_ts` and `first_ts` in epoch seconds, `tx` and `blocks` counts,
 * `gas` the average base fee in Gwei (NULL when no block of the hour has one). A missing `first_ts`
 * becomes NaN, not 0, so `completeUtcHours` drops the hour rather than reading it as whole.
 */
export function toHourRow(row: unknown): HourRow {
  const r = row as Record<string, unknown>
  const firstSeconds = r.first_ts == null || r.first_ts === '' ? NaN : Number(r.first_ts)
  return {
    hourMs: Math.round(Number(r.hour_ts) * 1000),
    firstTs: Math.round(firstSeconds * 1000),
    tx: Number(r.tx),
    blocks: Number(r.blocks),
    gas: r.gas == null ? null : Number(r.gas),
  }
}

/** An hour's x-axis tick: its UTC hour, "09:00". */
export function hourLabel(hourMs: number): string {
  return `${new Date(hourMs).toISOString().slice(11, 13)}:00`
}

/** "hourly · last 47 h": the span from the first to the last plotted hour, so a missing hour inside it is counted, not hidden. */
export function hourlyCaption(points: readonly { hourMs: number }[]): string | null {
  if (points.length === 0) return null
  const span = (points[points.length - 1].hourMs - points[0].hourMs) / HOUR_MS + 1
  return `hourly · last ${span} h`
}

/** The dated window in UTC ("2026-10-08 13:00 — 2026-10-10 11:00 UTC"), since the HH:00 ticks carry no date. */
export function hourlyRange(points: readonly { hourMs: number }[]): string | null {
  if (points.length === 0) return null
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 10) + ' ' + hourLabel(ms)
  const first = stamp(points[0].hourMs)
  const last = stamp(points[points.length - 1].hourMs)
  return first === last ? `${first} UTC` : `${first} — ${last} UTC`
}
