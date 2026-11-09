import { describe, expect, it } from 'vitest'
import { createFanoutStats, FANOUT_MAX_SAMPLES, FANOUT_SUMMARY_MS, summariseFanout } from './fanout-stats'

describe('summariseFanout', () => {
  it('gives max, p99 and total per column', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ tokens: i < 99 ? 1 : 40, pairs: i, pairDrops: i === 7 ? 2 : 0 }))
    expect(summariseFanout(samples, 600_000)).toBe(
      '[fanout] 600s: 100 blocks | new tokens per block max 40 p99 1 total 139'
      + ' | unknown pairs per block max 99 p99 98 total 4950 | swaps dropped (pair unreadable) max 2 total 2',
    )
  })

  it('reads zeros for no blocks', () => {
    expect(summariseFanout([], 0)).toContain('0 blocks | new tokens per block max 0 p99 0 total 0')
  })
})

describe('createFanoutStats', () => {
  it('logs once the window has passed, then starts a new one', () => {
    let t = 0
    const lines: string[] = []
    const stats = createFanoutStats(() => t, (l) => lines.push(l))
    stats.record({ tokens: 3, pairs: 1, pairDrops: 0 })
    t = FANOUT_SUMMARY_MS - 1
    stats.record({ tokens: 5, pairs: 2, pairDrops: 1 })
    expect(lines).toEqual([])
    t = FANOUT_SUMMARY_MS
    stats.record({ tokens: 1, pairs: 0, pairDrops: 0 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('3 blocks | new tokens per block max 5')
    t = FANOUT_SUMMARY_MS + 1
    stats.record({ tokens: 9, pairs: 0, pairDrops: 0 })
    expect(lines).toHaveLength(1)   // a fresh window
  })

  it('flushes early at the sample cap, so a catch-up cannot grow it without bound', () => {
    const lines: string[] = []
    const stats = createFanoutStats(() => 0, (l) => lines.push(l))
    for (let i = 0; i < FANOUT_MAX_SAMPLES; i++) stats.record({ tokens: 0, pairs: 0, pairDrops: 0 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`${FANOUT_MAX_SAMPLES} blocks`)
  })
})
