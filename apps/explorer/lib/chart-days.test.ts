import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeUtcDays, dateLabelIndices, toDayPoint, FIRST_DAY_TOLERANCE_MS } from '@/lib/chart-days'

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

  it('does not touch the input, and keeps the caller\'s extra fields', () => {
    const series = [{ ...day('2026-10-08', 1), tag: 'a' }, { ...day('2026-10-10', 2), tag: 'b' }]
    const copy = structuredClone(series)
    const out = completeUtcDays(series, NOW)
    expect(series).toEqual(copy)
    expect(out).toEqual([series[0]])
  })
})

// "Today" is the UTC date. In a UTC test run a local-time implementation (getDate() and friends) would
// pass by coincidence, so these pin a zone on either side of the date line and check the pin took.
describe('completeUtcDays: the UTC date, not the local one', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    // UTC+14: 23:30Z on the 9th is already the 10th locally, but still the 9th in UTC.
    ['Pacific/Kiritimati', '2026-10-09T23:30:00Z', 10, ['2026-10-08']],
    // UTC-11: 01:00Z on the 10th is still the 9th locally, but already the 10th in UTC.
    ['Pacific/Pago_Pago', '2026-10-10T01:00:00Z', 9, ['2026-10-08', '2026-10-09']],
  ])('in %s at %s', (zone, at, localDay, expected) => {
    vi.stubEnv('TZ', zone as string)
    const now = new Date(at as string)
    expect(now.getDate()).toBe(localDay) // the zone is really in force, or this test proves nothing
    const out = completeUtcDays([day('2026-10-08', 1000), day('2026-10-09', 900), day('2026-10-10', 100)], now)
    expect(out.map(d => d.date)).toEqual(expected)
  })
})

describe('dateLabelIndices', () => {
  it('spaces the labels by one step, first and last pinned', () => {
    expect(dateLabelIndices(3)).toEqual([0, 1, 2])
    expect(dateLabelIndices(5)).toEqual([0, 1, 2, 3, 4])
    expect(dateLabelIndices(7)).toEqual([0, 2, 4, 6])
    expect(dateLabelIndices(9)).toEqual([0, 2, 4, 6, 8])
    expect(dateLabelIndices(30)).toEqual([0, 8, 16, 29])
  })

  it('drops the label before the last when it would sit closer than a step to it', () => {
    expect(dateLabelIndices(8)).toEqual([0, 2, 4, 7])   // 6 is one apart from 7
    expect(dateLabelIndices(12)).toEqual([0, 3, 6, 11]) // 9 is two apart from 11, a step is 3
  })

  it('never puts two labels closer than a step, for any series length', () => {
    for (let n = 3; n <= 60; n++) {
      const idx = dateLabelIndices(n)
      const step = Math.ceil((n - 1) / 4)
      expect(idx[0]).toBe(0)
      expect(idx[idx.length - 1]).toBe(n - 1)
      expect(idx.length).toBeLessThanOrEqual(5)
      for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1], `n=${n}`).toBeGreaterThanOrEqual(step)
    }
  })

  it('copes with a degenerate series', () => {
    expect(dateLabelIndices(0)).toEqual([])
    expect(dateLabelIndices(1)).toEqual([0])
    expect(dateLabelIndices(2)).toEqual([0, 1])
  })
})

describe('toDayPoint', () => {
  it('reads a query row: date as YYYY-MM-DD, value as a number, first_ts (epoch seconds) as epoch ms', () => {
    expect(toDayPoint({ date: '2026-10-09', value: '1234', first_ts: '1791504002.25' }))
      .toEqual({ date: '2026-10-09', value: 1234, firstTs: 1791504002250 })
    expect(toDayPoint({ date: '2026-10-09T00:00:00.000Z', value: 7, first_ts: 1791504002 }).date).toBe('2026-10-09')
  })

  it('maps a missing first_ts to NaN, so completeUtcDays drops the day instead of treating it as a whole one', () => {
    for (const first_ts of [null, undefined, '', 'x']) {
      const point = toDayPoint({ date: '2026-10-06', value: 1000, first_ts })
      expect(point.firstTs, String(first_ts)).toBeNaN()
      expect(completeUtcDays([point, day('2026-10-07', 1000)], NOW).map(d => d.date)).toEqual(['2026-10-07'])
    }
  })
})
