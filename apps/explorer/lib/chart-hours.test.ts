import { describe, expect, it } from 'vitest'
import { dateLabelIndices } from '@/lib/chart-days'
import {
  completeUtcHours, FIRST_HOUR_TOLERANCE_MS, hourLabel, hourlyCaption, hourlyRange, MIN_HOURS, toHourRow,
} from '@/lib/chart-hours'

const HOUR = 3_600_000
const MIN = 60_000
// 12:34:56 UTC: the hour 12:00 is in progress, 11:00 is the newest whole one.
const NOW = new Date('2026-10-10T12:34:56Z')
const at = (iso: string) => Date.parse(iso)
// An hour's point; `firstAt` is when its earliest indexed block landed, as an offset from the hour start.
const hour = (iso: string, value: number, firstAt = 1_000) => ({ hourMs: at(iso), value, firstTs: at(iso) + firstAt })

describe('completeUtcHours', () => {
  it('drops the hour in progress, so the series cannot end on a fake drop', () => {
    // 11:00 holds a whole hour of blocks; 12:00 is 34 minutes in, so it holds about half.
    const series = [hour('2026-10-10T10:00:00Z', 8000), hour('2026-10-10T11:00:00Z', 8000), hour('2026-10-10T12:00:00Z', 4500)]
    expect(completeUtcHours(series, NOW).map(h => h.hourMs)).toEqual([at('2026-10-10T10:00:00Z'), at('2026-10-10T11:00:00Z')])
  })

  it('judges "in progress" by the clock\'s hour, not by the series: the first second of an hour already drops it', () => {
    const series = [hour('2026-10-10T10:00:00Z', 8000), hour('2026-10-10T11:00:00Z', 8000)]
    expect(completeUtcHours(series, new Date('2026-10-10T11:59:59.999Z'))).toHaveLength(1)
    expect(completeUtcHours(series, new Date('2026-10-10T12:00:00.000Z'))).toHaveLength(2)
  })

  it('drops a first hour whose earliest block is minutes after the hour start', () => {
    const series = [hour('2026-10-10T07:00:00Z', 3000, 40 * MIN), hour('2026-10-10T08:00:00Z', 8000), hour('2026-10-10T09:00:00Z', 8000)]
    expect(completeUtcHours(series, NOW).map(h => h.hourMs)).toEqual([at('2026-10-10T08:00:00Z'), at('2026-10-10T09:00:00Z')])
  })

  it('keeps a first hour that starts with the hour', () => {
    const series = [hour('2026-10-10T08:00:00Z', 8000, 0), hour('2026-10-10T09:00:00Z', 8000), hour('2026-10-10T10:00:00Z', 8000)]
    expect(completeUtcHours(series, NOW)).toHaveLength(3)
  })

  it('judges the first hour by the named tolerance, inclusive at the edge', () => {
    expect(FIRST_HOUR_TOLERANCE_MS).toBe(5 * MIN)
    const first = (firstAt: number) => completeUtcHours([hour('2026-10-10T08:00:00Z', 8000, firstAt), hour('2026-10-10T09:00:00Z', 8000)], NOW)
    expect(first(FIRST_HOUR_TOLERANCE_MS)).toHaveLength(2)
    expect(first(FIRST_HOUR_TOLERANCE_MS + 1)).toHaveLength(1)
  })

  it('drops a first hour whose start is unknown rather than plotting it as whole', () => {
    const unknown = { hourMs: at('2026-10-10T08:00:00Z'), value: 8000, firstTs: NaN }
    expect(completeUtcHours([unknown, hour('2026-10-10T09:00:00Z', 8000)], NOW).map(h => h.hourMs)).toEqual([at('2026-10-10T09:00:00Z')])
  })

  it('still drops it after a trip through the page cache, where JSON turns NaN into null', () => {
    const unknown = toHourRow({ hour_ts: at('2026-10-10T08:00:00Z') / 1000, first_ts: null, tx: 1, blocks: 1, gas: null })
    const cached = JSON.parse(JSON.stringify([unknown, hour('2026-10-10T09:00:00Z', 1)]))
    expect(cached[0].firstTs).toBeNull()
    expect(completeUtcHours(cached, NOW).map((h: { hourMs: number }) => h.hourMs)).toEqual([at('2026-10-10T09:00:00Z')])
  })

  it('returns nothing for an empty series, or one that is only the current hour', () => {
    expect(completeUtcHours([], NOW)).toEqual([])
    expect(completeUtcHours([hour('2026-10-10T12:00:00Z', 4500, 0)], NOW)).toEqual([])
  })

  it('does not touch the input, and keeps the caller\'s extra fields', () => {
    const series = [{ ...hour('2026-10-10T09:00:00Z', 1), tag: 'a' }, { ...hour('2026-10-10T12:00:00Z', 2), tag: 'b' }]
    const copy = structuredClone(series)
    const out = completeUtcHours(series, NOW)
    expect(series).toEqual(copy)
    expect(out).toEqual([series[0]])
  })

  it('keeps the 47 whole hours of a 49-bucket window across midnight (first starts late, current is in progress)', () => {
    const start = at('2026-10-08T12:00:00Z')
    const series = Array.from({ length: 49 }, (_, i) => ({
      hourMs: start + i * HOUR, value: 8000, firstTs: start + i * HOUR + (i === 0 ? 17 * MIN : 800),
    })) // 12:00 on the 8th through 12:00 on the 10th; the first starts 17 min late
    const out = completeUtcHours(series, NOW)
    expect(out).toHaveLength(47)
    expect(out[0].hourMs).toBe(at('2026-10-08T13:00:00Z'))
    expect(out[out.length - 1].hourMs).toBe(at('2026-10-10T11:00:00Z'))
  })

  it('names the fewest hours worth a chart', () => {
    expect(MIN_HOURS).toBe(6)
  })
})

describe('toHourRow', () => {
  it('reads a query row: hour_ts (epoch s) and first_ts (epoch s) as epoch ms, the three series as numbers', () => {
    expect(toHourRow({ hour_ts: '1791547200', first_ts: '1791547201.45', tx: '9876', blocks: '7999', gas: '3.1250' }))
      .toEqual({ hourMs: 1791547200000, firstTs: 1791547201450, tx: 9876, blocks: 7999, gas: 3.125 })
  })

  it('maps no base fee to null, not 0: a series of zeros is a number the chain never had', () => {
    for (const gas of [null, undefined]) {
      expect(toHourRow({ hour_ts: 1791547200, first_ts: 1791547201, tx: 1, blocks: 1, gas }).gas).toBeNull()
    }
  })

  it('maps a missing first_ts to NaN, so completeUtcHours drops the hour instead of treating it as a whole one', () => {
    for (const first_ts of [null, undefined, '', 'x']) {
      const row = toHourRow({ hour_ts: at('2026-10-10T08:00:00Z') / 1000, first_ts, tx: 1, blocks: 1, gas: null })
      expect(row.firstTs, String(first_ts)).toBeNaN()
      expect(completeUtcHours([row, hour('2026-10-10T09:00:00Z', 1)], NOW).map(h => h.hourMs)).toEqual([at('2026-10-10T09:00:00Z')])
    }
  })

  it('has only numbers in it, so it survives the cache\'s JSON.stringify (a BigInt would throw there)', () => {
    const row = toHourRow({ hour_ts: '1791547200', first_ts: '1791547201', tx: '5', blocks: '5', gas: '1' })
    expect(JSON.parse(JSON.stringify(row))).toEqual(row)
  })
})

describe('hourLabel', () => {
  it('is the UTC hour as HH:00, zero-padded', () => {
    expect(hourLabel(at('2026-10-10T00:00:00Z'))).toBe('00:00')
    expect(hourLabel(at('2026-10-10T09:00:00Z'))).toBe('09:00')
    expect(hourLabel(at('2026-10-10T23:00:00Z'))).toBe('23:00')
  })
})

describe('hourlyCaption and hourlyRange', () => {
  const run = (from: string, count: number) => Array.from({ length: count }, (_, i) => ({ hourMs: at(from) + i * HOUR }))

  it('names the window by its span: "hourly · last N h"', () => {
    expect(hourlyCaption(run('2026-10-08T13:00:00Z', 47))).toBe('hourly · last 47 h')
    expect(hourlyCaption(run('2026-10-10T05:00:00Z', 6))).toBe('hourly · last 6 h')
  })

  it('counts a missing hour inside the window: the span, not the number of points', () => {
    const gap = [{ hourMs: at('2026-10-10T05:00:00Z') }, { hourMs: at('2026-10-10T07:00:00Z') }, { hourMs: at('2026-10-10T10:00:00Z') }]
    expect(hourlyCaption(gap)).toBe('hourly · last 6 h') // 05:00 through 10:00
  })

  it('has no caption, and no range, for nothing to plot', () => {
    expect(hourlyCaption([])).toBeNull()
    expect(hourlyRange([])).toBeNull()
  })

  it('gives the dated range in UTC, so HH:00 ticks on a window that crosses midnight are not ambiguous', () => {
    expect(hourlyRange(run('2026-10-08T13:00:00Z', 47))).toBe('2026-10-08 13:00 — 2026-10-10 11:00 UTC')
    expect(hourlyRange(run('2026-10-10T05:00:00Z', 1))).toBe('2026-10-10 05:00 UTC')
  })
})

// The axis reuses #220's dateLabelIndices for hours. Two HH:00 labels about 28px wide, anchored by
// their own share of the plot, are `(p2 - p1) * (plot - 28)` apart; the narrowest plot is a 320px
// phone with the y labels beside it (about 170px). So every pair must be at least a quarter of the
// plot apart, for every window the fallback can draw (6 to 96 hours).
describe('hour ticks: dateLabelIndices on hourly counts', () => {
  it('never puts two labels nearer than a quarter of the plot, up to 5 labels, first and last pinned', () => {
    for (let n = MIN_HOURS; n <= 96; n++) {
      const idx = dateLabelIndices(n)
      expect(idx[0]).toBe(0)
      expect(idx[idx.length - 1]).toBe(n - 1)
      expect(idx.length).toBeLessThanOrEqual(5)
      for (let i = 1; i < idx.length; i++) {
        expect((idx[i] - idx[i - 1]) / (n - 1), `n=${n} idx=${idx}`).toBeGreaterThanOrEqual(0.25 - 1e-9)
      }
    }
  })
})
