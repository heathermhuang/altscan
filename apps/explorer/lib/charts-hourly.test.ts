import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

const { execute, createPageCache } = vi.hoisted(() => ({
  execute: vi.fn(),
  // The identity wrapper: what the module hands createPageCache (name, TTL, the query) is observable.
  createPageCache: vi.fn((_name: string, _ttl: number, query: unknown) => query),
}))
vi.mock('@/lib/db', () => ({ db: { execute } }))
vi.mock('@/lib/page-cache', () => ({ createPageCache }))

import {
  CHARTS_HOURLY_REVALIDATE_SECONDS, HOURLY_WINDOW_HOURS, hourlyChartQuery, queryHourlyChart,
} from '@/lib/charts-hourly'

// createPageCache is called when the module loads: read its arguments before beforeEach clears them.
const cacheArgs = createPageCache.mock.calls[0]

beforeEach(() => { execute.mockReset() })

describe('the hourly query', () => {
  const rendered = () => new PgDialect().sqlToQuery(hourlyChartQuery())

  it('is one aggregate over blocks, bounded to the window, one row per UTC hour in order', () => {
    const { sql: text, params } = rendered()
    expect(text).toMatch(/FROM blocks b/)
    expect(text).toMatch(/b\.timestamp >= NOW\(\) - make_interval\(hours => \$1::int\)/)
    expect(params).toEqual([HOURLY_WINDOW_HOURS])
    expect(text).toMatch(/date_trunc\('hour', b\.timestamp AT TIME ZONE 'UTC'\) AS hour,/)
    expect(text).toMatch(/GROUP BY 1\s*\)\s*h\s+ORDER BY 1/)
    expect(text.match(/FROM blocks/g)).toHaveLength(1) // one scan, three series
  })

  it('groups by the truncated timestamp and takes the epoch outside the GROUP BY', () => {
    // Grouping by EXTRACT(EPOCH FROM date_trunc(...)) made Postgres sort all 400k rows through a 13 MB
    // disk spill (212 ms); grouping by the timestamp itself hash-aggregates them (115 ms, no spill).
    const { sql: text } = rendered()
    expect(text).toMatch(/SELECT EXTRACT\(EPOCH FROM h\.hour\) AS hour_ts/)
    expect(text).not.toMatch(/GROUP BY[^)]*EXTRACT/)
  })

  it('takes the average base fee over the blocks that have one, so a chain with none reads NULL, not 0', () => {
    expect(rendered().sql).toMatch(/AVG\(b\.base_fee_per_gas \/ 1e9\) FILTER \(WHERE b\.base_fee_per_gas > 0\)/)
  })

  it('reads three days back, which covers every window the fallback can draw', () => {
    expect(HOURLY_WINDOW_HOURS).toBe(72)
  })
})

describe('queryHourlyChart (what the cache wraps)', () => {
  it('maps the rows to plain numbers and stamps the moment it ran', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-10T12:34:56Z') })
    try {
      execute.mockResolvedValue([
        { hour_ts: '1791547200', tx: '9876', blocks: '7999', gas: null, first_ts: '1791547200.45' },
        { hour_ts: '1791550800', tx: '9100', blocks: '8000', gas: '3.1250', first_ts: '1791550800.9' },
      ])
      const out = await queryHourlyChart()
      expect(out.asOf).toBe(Date.parse('2026-10-10T12:34:56Z'))
      expect(out.rows).toEqual([
        { hourMs: 1791547200000, firstTs: 1791547200450, tx: 9876, blocks: 7999, gas: null },
        { hourMs: 1791550800000, firstTs: 1791550800900, tx: 9100, blocks: 8000, gas: 3.125 },
      ])
    } finally { vi.useRealTimers() }
  })

  it('survives the cache\'s JSON.stringify (a BigInt would throw inside Next\'s write)', async () => {
    execute.mockResolvedValue([{ hour_ts: '1791547200', tx: '1', blocks: '1', gas: '1', first_ts: '1791547200' }])
    const out = await queryHourlyChart()
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  it('REJECTS when the query fails, so a failure is never cached as an empty chart', async () => {
    execute.mockRejectedValue(new Error('boom'))
    await expect(queryHourlyChart()).rejects.toThrow('boom')
  })

  it('REJECTS when the query hangs past the page deadline', async () => {
    vi.useFakeTimers()
    try {
      execute.mockReturnValue(new Promise(() => {}))
      const pending = queryHourlyChart()
      const settled = expect(pending).rejects.toThrow('query timeout')
      await vi.advanceTimersByTimeAsync(8000)
      await settled
    } finally { vi.useRealTimers() }
  })
})

describe('the cache around it', () => {
  it('is named charts-hourly, for the page\'s own revalidate window', () => {
    expect(cacheArgs[0]).toBe('charts-hourly')
    expect(cacheArgs[1]).toBe(CHARTS_HOURLY_REVALIDATE_SECONDS)
    expect(CHARTS_HOURLY_REVALIDATE_SECONDS).toBe(300)
  })
})
