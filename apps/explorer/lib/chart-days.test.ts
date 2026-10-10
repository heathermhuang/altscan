import { describe, expect, it } from 'vitest'
import { completeUtcDays, FIRST_DAY_TOLERANCE_MS } from '@/lib/chart-days'

const NOW = new Date('2026-10-10T12:00:00Z')
const MIN = 60_000
// A day's point; `firstAt` is when its earliest indexed block landed, as an offset from 00:00 UTC.
const day = (date: string, value: number, firstAt = 3_000) => ({
  date, value, firstTs: Date.parse(`${date}T00:00:00Z`) + firstAt,
})

describe('completeUtcDays', () => {
  it('drops today, so a 3-point series cannot end on a fake drop', () => {
    // The first two days are 100% of a day; today is 12 hours in, so it holds about half.
    const series = [day('2026-10-08', 1000), day('2026-10-09', 1000), day('2026-10-10', 480)]
    const out = completeUtcDays(series, NOW)
    expect(out.map(d => d.date)).toEqual(['2026-10-08', '2026-10-09'])
    expect(out.length).toBeLessThan(3) // the caller's "Not enough data yet" threshold
  })

  it('drops a first day whose earliest block is hours after midnight UTC', () => {
    const series = [day('2026-10-05', 300, 14 * 60 * MIN), day('2026-10-06', 1000), day('2026-10-07', 1000), day('2026-10-08', 1000)]
    expect(completeUtcDays(series, NOW).map(d => d.date)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08'])
  })

  it('keeps a first day that starts at midnight', () => {
    const series = [day('2026-10-06', 1000, 0), day('2026-10-07', 1000), day('2026-10-08', 1000)]
    expect(completeUtcDays(series, NOW)).toHaveLength(3)
  })

  it('judges the first day by the tolerance, inclusive at the edge', () => {
    const at = (firstAt: number) => completeUtcDays([day('2026-10-06', 1000, firstAt), day('2026-10-07', 1000)], NOW)
    expect(at(FIRST_DAY_TOLERANCE_MS)).toHaveLength(2)
    expect(at(FIRST_DAY_TOLERANCE_MS + 1)).toHaveLength(1)
  })

  it('drops a first day whose start is unknown rather than plotting it as whole', () => {
    const unknown = { date: '2026-10-06', value: 1000, firstTs: NaN }
    expect(completeUtcDays([unknown, day('2026-10-07', 1000)], NOW).map(d => d.date)).toEqual(['2026-10-07'])
  })

  it('keeps exactly 3 complete days when today is also present', () => {
    const series = [day('2026-10-07', 1000), day('2026-10-08', 1000), day('2026-10-09', 1000), day('2026-10-10', 480)]
    expect(completeUtcDays(series, NOW).map(d => d.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09'])
  })

  it('returns nothing for an empty series, or one that is only today', () => {
    expect(completeUtcDays([], NOW)).toEqual([])
    expect(completeUtcDays([day('2026-10-10', 480, 0)], NOW)).toEqual([])
  })

  it('treats the UTC date as today, not the local one', () => {
    // 23:30 UTC on the 9th is already the 10th in UTC+2; the 9th must still count as today in UTC.
    const late = new Date('2026-10-09T23:30:00Z')
    const out = completeUtcDays([day('2026-10-08', 1000), day('2026-10-09', 900)], late)
    expect(out.map(d => d.date)).toEqual(['2026-10-08'])
  })

  it('does not touch the input, and keeps the caller\'s extra fields', () => {
    const series = [{ ...day('2026-10-08', 1), tag: 'a' }, { ...day('2026-10-10', 2), tag: 'b' }]
    const copy = structuredClone(series)
    const out = completeUtcDays(series, NOW)
    expect(series).toEqual(copy)
    expect(out).toEqual([series[0]])
  })
})
