import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { execute, fetchHourlyChart, fetchRecentTape } = vi.hoisted(() => ({
  execute: vi.fn(),
  fetchHourlyChart: vi.fn(),
  fetchRecentTape: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: { execute } }))
vi.mock('@/lib/charts-hourly', () => ({ fetchHourlyChart }))
vi.mock('@/lib/recent-tape', () => ({ fetchRecentTape }))
vi.mock('@/components/home/BlockTape', () => ({ BlockTape: () => createElement('div', { 'data-tape': true }) }))

import Page from './page'

const HOUR = 3_600_000
const NOW = new Date('2026-10-10T12:34:56Z')
const at = (iso: string) => Date.parse(iso)
// An hourly row as the cached query hands it over; every hour's earliest block lands a second in.
const hourRow = (hourMs: number, over: Partial<{ tx: number; blocks: number; gas: number | null; firstTs: number }> = {}) =>
  ({ hourMs, firstTs: hourMs + 1_000, tx: 9000, blocks: 8000, gas: null, ...over })
// `count` consecutive hours ending at (and including) `lastIso`.
const hours = (lastIso: string, count: number, over?: Parameters<typeof hourRow>[1]) =>
  Array.from({ length: count }, (_, i) => hourRow(at(lastIso) - (count - 1 - i) * HOUR, over))
const dayRow = (date: string, value: number) => ({ date, value, first_ts: String(Date.parse(`${date}T00:00:03Z`) / 1000) })

async function render() {
  return renderToStaticMarkup(await Page())
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  execute.mockReset().mockResolvedValue([]) // no daily series at all
  fetchHourlyChart.mockReset()
  fetchRecentTape.mockReset().mockResolvedValue('tape')
})
afterEach(() => { vi.useRealTimers() })

describe('/charts with fewer than three whole UTC days', () => {
  it('plots hourly, labelled, instead of the tape and the "not available yet" line', async () => {
    // 12:00 on the 10th is in progress; 09:00 on the 8th starts late. 47 whole hours remain.
    fetchHourlyChart.mockResolvedValue({
      asOf: NOW.getTime(),
      rows: [hourRow(at('2026-10-08T12:00:00Z'), { firstTs: at('2026-10-08T12:17:00Z') }), ...hours('2026-10-10T12:00:00Z', 48)],
    })
    const html = await render()
    expect(html).toContain('Hourly Transaction Count')
    expect(html).toContain('Hourly Block Count')
    expect(html).toContain('hourly · last 47 h')
    expect(html).toContain('2026-10-08 13:00 — 2026-10-10 11:00 UTC')
    expect(html).not.toContain('Daily Transaction Count')
    expect(html).not.toContain('available yet')
    expect(html).not.toContain('data-tape')
    expect(fetchRecentTape).not.toHaveBeenCalled()
  })

  it('draws the plot with HH:00 ticks on the existing axis, first and last hour pinned', async () => {
    fetchHourlyChart.mockResolvedValue({ asOf: NOW.getTime(), rows: hours('2026-10-10T11:00:00Z', 24) })
    const html = await render()
    const ticks = [...html.matchAll(/<span class="absolute whitespace-nowrap"[^>]*>(\d\d:\d\d)<\/span>/g)].map(m => m[1])
    // 24 hours 12:00 yesterday to 11:00 today: dateLabelIndices(24) = 0, 6, 12, 23. Two charts, same ticks.
    expect(ticks).toEqual(['12:00', '18:00', '00:00', '11:00', '12:00', '18:00', '00:00', '11:00'])
    expect(html.match(/role="img"/g)).toHaveLength(2) // transactions and blocks; the gas card says why it has none
  })

  it('never plots the hour in progress, however recent the cached rows are', async () => {
    fetchHourlyChart.mockResolvedValue({ asOf: NOW.getTime(), rows: hours('2026-10-10T12:00:00Z', 10) })
    const html = await render()
    expect(html).toContain('hourly · last 9 h') // 03:00 through 11:00; 12:00 is dropped
    expect(html).not.toContain('2026-10-10 12:00')
  })

  it('judges the hour in progress at the moment the rows were read, not when they are rendered', async () => {
    // The cache read the rows at 11:58, so the 11:00 bucket was still filling. The page renders them at
    // 12:34 (a later hour), but that bucket never became whole in these rows.
    fetchHourlyChart.mockResolvedValue({ asOf: at('2026-10-10T11:58:00Z'), rows: hours('2026-10-10T11:00:00Z', 10) })
    const html = await render()
    expect(html).toContain('hourly · last 9 h') // 02:00 through 10:00
    expect(html).not.toContain('2026-10-10 11:00')
  })

  it('keeps the tape and the line when there are fewer than six whole hours', async () => {
    fetchHourlyChart.mockResolvedValue({ asOf: NOW.getTime(), rows: hours('2026-10-10T12:00:00Z', 6) }) // 5 whole
    const html = await render()
    expect(html).toContain('data-tape')
    expect(html).toContain('available yet')
    expect(html).not.toContain('Hourly')
  })

  it('draws six whole hours', async () => {
    fetchHourlyChart.mockResolvedValue({ asOf: NOW.getTime(), rows: hours('2026-10-10T12:00:00Z', 7) })
    const html = await render()
    expect(html).toContain('hourly · last 6 h')
    expect(html).not.toContain('data-tape')
  })

  it('falls back to the tape when the hourly query fails, instead of erroring the page', async () => {
    fetchHourlyChart.mockRejectedValue(new Error('query timeout'))
    const html = await render()
    expect(html).toContain('data-tape')
    expect(html).toContain('available yet')
  })

  it('plots the base fee as a third chart where the chain has one, and says why not where it has none', async () => {
    fetchHourlyChart.mockResolvedValue({ asOf: NOW.getTime(), rows: hours('2026-10-10T12:00:00Z', 12, { gas: 3 }) })
    const withFee = await render()
    expect(withFee.match(/role="img"/g)).toHaveLength(3)
    expect(withFee).toContain('3 Gwei')

    fetchHourlyChart.mockResolvedValue({ asOf: NOW.getTime(), rows: hours('2026-10-10T12:00:00Z', 12, { gas: null }) })
    const without = await render()
    expect(without.match(/role="img"/g)).toHaveLength(2)
    expect(without).toContain('has a low minimum gas price')
    // Axe's link-in-text-block: a link inside a sentence must differ from the text by more than colour.
    expect(without).toMatch(/<a href="\/gas" class="(?:[^"]* )?underline[ "]/)
  })
})

describe('/charts with three whole UTC days', () => {
  it('keeps the daily charts, and never reads the hourly series or the tape', async () => {
    const days = [dayRow('2026-10-06', 1000), dayRow('2026-10-07', 1100), dayRow('2026-10-08', 1200), dayRow('2026-10-09', 1300), dayRow('2026-10-10', 400)]
    execute.mockResolvedValue(days)
    const html = await render()
    expect(html).toContain('Daily Transaction Count')
    expect(html).toContain('Daily Block Count')
    expect(html).not.toContain('Hourly')
    expect(fetchHourlyChart).not.toHaveBeenCalled()
    expect(fetchRecentTape).not.toHaveBeenCalled()
  })
})
