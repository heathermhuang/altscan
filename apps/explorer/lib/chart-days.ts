/**
 * Which days of a daily series /charts may plot.
 *
 * Each point is a whole UTC day, so a day that is not whole reads as a collapse: today (hours old) or
 * the first day of a series that starts mid-day (the 30-day window cuts at NOW() - 30d, and a young
 * index has history only from when it began). A 3-point series ending on today drew a fake 50% drop.
 */

/**
 * How far after 00:00 UTC the first day's earliest block may land and still count as a whole day.
 *
 * Judged from the data, not the calendar: the first day is whole only if its earliest block is at the
 * start of the day. A block lands every 0.45 s on BNB and 12 s on ETH, so a whole day starts within
 * seconds; 5 minutes leaves room for an indexer restart or RPC failover at midnight. A day that starts
 * 5 minutes late is missing 0.35% of its blocks, under one pixel on a 200px axis that starts at 0.
 */
export const FIRST_DAY_TOLERANCE_MS = 5 * 60_000

/**
 * `days` (ascending, one point per UTC date, `firstTs` the epoch ms of that day's earliest block)
 * without today and, when the series starts mid-day, without its first day. `now` is a parameter so
 * the cut is testable.
 */
export function completeUtcDays<T extends { date: string; firstTs: number }>(days: readonly T[], now: Date): T[] {
  const today = now.toISOString().slice(0, 10)
  const past = days.filter(d => d.date < today)
  const first = past[0]
  // Written so an unknown start (NaN) fails the test and the day is dropped, never plotted as whole.
  const startsAtMidnight = first !== undefined && first.firstTs - Date.parse(`${first.date}T00:00:00Z`) <= FIRST_DAY_TOLERANCE_MS
  return first === undefined || startsAtMidnight ? past : past.slice(1)
}

/** One day of a daily series. */
export type DataPoint = { date: string; value: number; firstTs: number }

/**
 * A row of the daily GROUP BY queries: `date`, `value`, and `first_ts`, the epoch seconds of the day's
 * earliest block. A missing `first_ts` becomes NaN, not 0 (Number(null)), so `completeUtcDays` drops
 * the day rather than reading it as starting at the epoch, hence "whole".
 */
export function toDayPoint(row: unknown): DataPoint {
  const r = row as Record<string, unknown>
  const firstSeconds = r.first_ts == null || r.first_ts === '' ? NaN : Number(r.first_ts)
  return {
    date: String(r.date).slice(0, 10),
    value: Number(r.value),
    firstTs: Math.round(firstSeconds * 1000),
  }
}

/**
 * Which of `count` evenly spaced points get a date label: one every `step` points (up to
 * `maxLabels` labels), first and last always labelled. A label that would sit closer than one step
 * to the last is dropped, so no two labels are ever nearer than a step. Rounding evenly spaced
 * positions instead (k * last / 4) gave steps of 1 and 2 on a 7- or 8-point series, and the labels,
 * about 30px wide, overlapped on a phone.
 */
export function dateLabelIndices(count: number, maxLabels = 5): number[] {
  if (count < 2) return count === 1 ? [0] : []
  const last = count - 1
  const step = Math.ceil(last / (maxLabels - 1))
  const indices: number[] = []
  for (let i = 0; i < last; i += step) indices.push(i)
  if (indices.length > 1 && last - indices[indices.length - 1] < step) indices.pop()
  indices.push(last)
  return indices
}
