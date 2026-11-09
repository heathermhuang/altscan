import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMoralisAdapter } from './moralis'
import { withClientAdmission } from './client-admission'

// A client's own budget is charged only on BILLED calls: the adapter asks it right before it spends, after the
// response cache. A cache hit costs nothing, and a refusal never reaches the provider.
const CFG = { kind: 'moralis' as const, moralisChain: '0x38' }
const page = { result: [], cursor: null }

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('withClientAdmission', () => {
  it('a refused client never reaches the provider, and gets rate_limited', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const admit = vi.fn(async () => false)
    const r = await withClientAdmission(admit, () => createMoralisAdapter(CFG).getAddressHistory('0xca-refused'))
    expect(r).toEqual({ ok: false, reason: 'rate_limited' })
    expect(admit).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is asked once per billed call, and never for a cache hit', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })))
    const a = createMoralisAdapter(CFG)
    const admit = vi.fn(async () => true)
    expect((await withClientAdmission(admit, () => a.getAddressHistory('0xca-cached'))).ok).toBe(true)
    expect(admit).toHaveBeenCalledTimes(1)
    const refuse = vi.fn(async () => false)
    expect((await withClientAdmission(refuse, () => a.getAddressHistory('0xca-cached'))).ok, 'served from cache').toBe(true)
    expect(refuse).not.toHaveBeenCalled()
  })

  it('outside a client scope nothing changes', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(page), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await createMoralisAdapter(CFG).getAddressHistory('0xca-noscope')).ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
