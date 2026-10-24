/**
 * notifyWebhooks is fired once per block without being awaited (block-processor), and a run
 * waits on each delivery in turn. Endpoints that answer slowly therefore stack one run per
 * block; past the cap, a block's notifications are skipped instead of growing without bound.
 * The database and network are faked; nothing here reaches either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ selects: 0, fetches: 0, release: [] as Array<() => void> }))

vi.mock('./db', async (orig) => {
  const where = async () => {
    h.selects++
    return [{ id: 1, url: 'https://hooks.example.com/x', secret: 'k', watchAddress: null, eventTypes: ['tx'] }]
  }
  const db = {
    select: () => ({ from: () => ({ where }) }),
    execute: async () => [{ webhook_id: 1 }], // the delivery claim
    update: () => ({ set: () => ({ where: async () => [] }) }),
  }
  return { ...(await orig<typeof import('./db')>()), getDb: () => db }
})
vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }))

const tx = [{ hash: '0x01', fromAddress: '0x' + 'a'.repeat(40), toAddress: null, value: '1' }]

afterEach(() => { vi.unstubAllGlobals() })

describe('notifyWebhooks in-flight cap', () => {
  it('skips a block while the cap of runs is still waiting on deliveries', async () => {
    vi.stubGlobal('fetch', () => {
      h.fetches++
      return new Promise<Response>((resolve) => h.release.push(() => resolve(new Response(null, { status: 200 }))))
    })
    const { notifyWebhooks, MAX_INFLIGHT_NOTIFY_RUNS } = await import('./webhook-notifier')

    const runs = Array.from({ length: MAX_INFLIGHT_NOTIFY_RUNS }, (_, i) =>
      notifyWebhooks(tx, i, new Date(), `0x${i}`))
    await vi.waitFor(() => expect(h.fetches).toBe(MAX_INFLIGHT_NOTIFY_RUNS))

    await notifyWebhooks(tx, 999, new Date(), '0x999') // returns at once: no select, no delivery
    expect(h.selects).toBe(MAX_INFLIGHT_NOTIFY_RUNS)

    h.release.forEach((r) => r())
    await Promise.all(runs)
    // Slots free again once the slow runs finish.
    h.release.length = 0
    const next = notifyWebhooks(tx, 1000, new Date(), '0x1000')
    await vi.waitFor(() => expect(h.fetches).toBe(MAX_INFLIGHT_NOTIFY_RUNS + 1))
    h.release.forEach((r) => r())
    await next
    expect(h.selects).toBe(MAX_INFLIGHT_NOTIFY_RUNS + 1)
  })
})

// f027. Both chains deliver the same shape from the same code, so a consumer registered on BNB and ETH had no
// way to tell a payload's chain apart. The field is additive: nothing existing moves or changes type.
describe('notifyWebhooks payload', () => {
  const deliveredBody = async (): Promise<Record<string, unknown>> => {
    let sent: RequestInit | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent = init
      return new Response(null, { status: 200 })
    })
    const { notifyWebhooks } = await import('./webhook-notifier')
    await notifyWebhooks(tx, 42, new Date(0), '0x42')
    if (!sent) throw new Error('no delivery was attempted')
    return JSON.parse(sent.body as string)
  }

  afterEach(() => { delete process.env.CHAIN })

  it('carries the chain id, 56 on bnb and 1 on eth', async () => {
    process.env.CHAIN = 'bnb'
    expect((await deliveredBody()).chainId).toBe(56)
    process.env.CHAIN = 'eth'
    expect((await deliveredBody()).chainId).toBe(1)
  })

  it('keeps every existing field', async () => {
    const body = await deliveredBody()
    expect(Object.keys(body).sort()).toEqual(['blockNumber', 'chainId', 'count', 'data', 'event', 'timestamp'])
    expect(body).toMatchObject({ event: 'tx', blockNumber: 42, count: 1 })
  })
})
