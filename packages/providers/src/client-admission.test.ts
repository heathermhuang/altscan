import { afterEach, describe, expect, it, vi } from 'vitest'

// A client's own budget is charged only on BILLED calls: the adapter asks it right before it spends, after the
// response cache. A cache hit costs nothing, a refusal never reaches the provider, and a call the fleet-wide admission
// then refuses gives the client's charge back.
const CFG = { kind: 'moralis' as const, moralisChain: '0x38' }
const page = { result: [], cursor: null }
const admission = (admit: boolean) => ({ admit: vi.fn(async () => admit), release: vi.fn(async () => {}) })

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })

async function load() {
  const { createMoralisAdapter } = await import('./moralis')
  const { withClientAdmission } = await import('./client-admission')
  return { createMoralisAdapter, withClientAdmission }
}

describe('withClientAdmission', () => {
  it('a refused client never reaches the provider, and gets rate_limited', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { createMoralisAdapter, withClientAdmission } = await load()
    const c = admission(false)
    const r = await withClientAdmission(c, () => createMoralisAdapter(CFG).getAddressHistory('0xca-refused'))
    expect(r).toEqual({ ok: false, reason: 'rate_limited' })
    expect(c.admit).toHaveBeenCalledTimes(1)
    expect(c.release).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is charged once per billed call, and never for a cache hit', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })))
    const { createMoralisAdapter, withClientAdmission } = await load()
    const a = createMoralisAdapter(CFG)
    const first = admission(true)
    expect((await withClientAdmission(first, () => a.getAddressHistory('0xca-cached'))).ok).toBe(true)
    expect(first.admit).toHaveBeenCalledTimes(1)
    expect(first.release).not.toHaveBeenCalled()
    const second = admission(false)
    expect((await withClientAdmission(second, () => a.getAddressHistory('0xca-cached'))).ok, 'served from cache').toBe(true)
    expect(second.admit).not.toHaveBeenCalled()
  })

  // Codex round one: charged before a fleet refusal, the client's hourly allowance burned on calls never sent.
  it('gives the charge back when the fleet-wide admission then refuses the call', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    vi.stubEnv('MORALIS_HISTORY_HOURLY_MAX', '1')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(page), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { createMoralisAdapter, withClientAdmission } = await load()
    const a = createMoralisAdapter(CFG)
    const ok = admission(true)
    expect((await withClientAdmission(ok, () => a.getAddressHistory('0xca-fleet-1'))).ok).toBe(true)
    expect(ok.release).not.toHaveBeenCalled()
    const refused = admission(true)
    expect(await withClientAdmission(refused, () => a.getAddressHistory('0xca-fleet-2'))).toEqual({ ok: false, reason: 'rate_limited' })
    expect(refused.admit).toHaveBeenCalledTimes(1)
    expect(refused.release, 'the fleet refused: the client is refunded').toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('outside a client scope nothing changes', async () => {
    vi.stubEnv('MORALIS_API_KEY', 'k')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(page), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { createMoralisAdapter } = await load()
    expect((await createMoralisAdapter(CFG).getAddressHistory('0xca-noscope')).ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
