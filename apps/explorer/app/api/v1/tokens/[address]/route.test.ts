import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WELL_KNOWN } from '@/lib/lookalike'
import { chainConfig } from '@/lib/chain'

const h = vi.hoisted(() => ({ rows: [] as unknown[] }))

vi.mock('@/lib/api-rate-limit', () => ({ checkIpRateLimit: async () => true }))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const chain = { from: () => chain, where: () => chain, limit: async () => h.rows }
  return { schema, db: { select: () => chain } }
})

const get = async (address: string) => {
  const { GET } = await import('./route')
  return GET(new Request(`http://x/api/v1/tokens/${address}`), { params: Promise.resolve({ address }) })
}

const usdt = WELL_KNOWN[chainConfig.key].find((w) => w.symbol === 'USDT')!
const FAKE = '0x' + '12'.repeat(20)

beforeEach(() => { h.rows = [] })

// The lookalike match is evidence for agents and wallets, never a verdict.
describe('GET /api/v1/tokens/:contract lookalike', () => {
  it('names the well-known token an imitator reads as, with the real contract', async () => {
    h.rows = [{ address: FAKE, name: 'Tether USD', symbol: 'USDT', decimals: 6 }]
    const body = await (await get(FAKE)).json()
    expect(body.lookalike).toEqual({ symbol: 'USDT', canonical: usdt.addresses[0] })
  })

  it('returns null for the real contract and for unrelated tokens', async () => {
    h.rows = [{ address: usdt.addresses[0], name: 'Tether USD', symbol: 'USDT', decimals: 6 }]
    expect((await (await get(usdt.addresses[0])).json()).lookalike).toBeNull()
    h.rows = [{ address: FAKE, name: 'Some Token', symbol: 'SOME', decimals: 18 }]
    expect((await (await get(FAKE)).json()).lookalike).toBeNull()
  })
})

// The fields come back as stored; the flag says they hold Unicode direction controls (lib/directional-controls).
describe('GET /api/v1/tokens/:contract directionalControls', () => {
  it('is true when the name or symbol holds one, false otherwise', async () => {
    h.rows = [{ address: FAKE, name: 'Spoof', symbol: '\u202ETDSU\u202C', decimals: 6 }]
    const flagged = await (await get(FAKE)).json()
    expect(flagged.directionalControls).toBe(true)
    expect(flagged.token.symbol).toBe('\u202ETDSU\u202C')
    h.rows = [{ address: FAKE, name: 'Spoof', symbol: 'TDSU', decimals: 6 }]
    expect((await (await get(FAKE)).json()).directionalControls).toBe(false)
  })
})
