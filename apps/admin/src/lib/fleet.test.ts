import { describe, expect, it } from 'vitest'
import { buildFleetPayload, type ExplorerProbe } from './fleet'

const explorer = {
  id: 'bnb',
  brand: 'BNBScan',
  publicUrl: 'https://bnbscan.com',
  status: 'live',
} as ExplorerProbe['explorer']

describe('buildFleetPayload', () => {
  it('maps a healthy probe', () => {
    const p = buildFleetPayload(
      [
        {
          explorer,
          health: {
            ok: true,
            status: 200,
            body: { status: 'ok', latestBlock: 123, lagSeconds: 9, database: { sizeMB: 42 }, memory: { status: 'ok' }, moralis: { history: { daily: 10, dailyMax: 100 } } },
          },
          deploys: {
            web: { status: 'live', finishedAt: 't', commit: 'abc1234' },
            indexer: { status: 'live', finishedAt: 't', commit: 'abc1234' },
          },
        },
      ],
      1000,
    )
    expect(p.generatedAt).toBe(1000)
    expect(p.explorers[0]).toMatchObject({
      id: 'bnb',
      health: 'ok',
      latestBlock: 123,
      lagSeconds: 9,
      dbSizeMB: 42,
    })
    expect(p.explorers[0].moralis).toEqual({ history: { daily: 10, dailyMax: 100 } })
  })

  it('marks unreachable probes and never throws on garbage bodies', () => {
    const p = buildFleetPayload(
      [{ explorer, health: { ok: false, status: 0, body: null }, deploys: {} }],
      0,
    )
    expect(p.explorers[0].health).toBe('unreachable')
    expect(p.explorers[0].latestBlock).toBeNull()
  })

  it('passes through degraded status', () => {
    const p = buildFleetPayload(
      [{ explorer, health: { ok: true, status: 200, body: { status: 'degraded' } }, deploys: {} }],
      0,
    )
    expect(p.explorers[0].health).toBe('degraded')
  })
})
