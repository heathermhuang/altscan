import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./cache-registry', () => ({ registerCache: vi.fn() }))

type Goplus = typeof import('./goplus')
let g: Goplus
const ADDR = '0x' + 'ab'.repeat(20)
const clean = { code: 1, result: { contract_address: '0', malicious_address: '0', phishing_activities: '0', blacklist_doubt: '0' } }
const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }))

beforeEach(async () => {
  vi.resetModules()   // a fresh cache per test
  g = await import('./goplus')
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('parseAddressSecurity', () => {
  it('reads a clean verdict and a flagged one', () => {
    expect(g.parseAddressSecurity(clean)).toEqual({ isContract: false, isMalicious: false, isPhishing: false, isBlacklist: false, riskItems: [] })
    const flagged = g.parseAddressSecurity({ code: 1, result: { ...clean.result, contract_address: '1', phishing_activities: '1' } })
    expect(flagged).toMatchObject({ isContract: true, isPhishing: true, riskItems: ['Known phishing activity'] })
  })

  // A missing flag used to read as "not flagged": the page then showed nothing, as for a clean address.
  it.each([
    ['an error code', { code: 4029, message: 'too many requests', result: clean.result }],
    ['no result', { code: 1 }],
    ['a missing flag', { code: 1, result: { malicious_address: '0', phishing_activities: '0' } }],
    ['an odd flag value', { code: 1, result: { ...clean.result, blacklist_doubt: 'unknown' } }],
    ['not an object', 'Service Unavailable'],
  ])('is no verdict for %s', (_label, body) => {
    expect(g.parseAddressSecurity(body)).toBeNull()
  })
})

describe('getAddressRisk caching', () => {
  it('caches a verdict, per address and case-insensitively', async () => {
    const fetch = answer(clean)
    vi.stubGlobal('fetch', fetch)
    await g.getAddressRisk(ADDR)
    await g.getAddressRisk(ADDR.toUpperCase().replace('0X', '0x'))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an error code', answer({ code: 4029, result: clean.result })],
    ['a partial result', answer({ code: 1, result: { malicious_address: '0' } })],
    ['a non-OK response', answer(clean, false)],
    ['a network failure', vi.fn(async () => { throw new Error('fetch failed') })],
  ])('never caches %s, and asks again', async (_label, fetch) => {
    vi.stubGlobal('fetch', fetch)
    expect(await g.getAddressRisk(ADDR)).toBeNull()
    expect(await g.getAddressRisk(ADDR)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('bypasses Next\'s fetch cache, which kept any 200 answer', async () => {
    const fetch = answer(clean)
    vi.stubGlobal('fetch', fetch)
    await g.getAddressRisk(ADDR)
    expect(fetch.mock.calls[0]).toEqual([expect.stringContaining(`/address_security/${ADDR}`), expect.objectContaining({ cache: 'no-store' })])
  })

  it('asks again once a verdict is ten minutes old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetch = answer(clean)
    vi.stubGlobal('fetch', fetch)
    await g.getAddressRisk(ADDR)
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1)
    await g.getAddressRisk(ADDR)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('holds at most 5,000 verdicts, dropping the oldest', async () => {
    const fetch = answer(clean)
    vi.stubGlobal('fetch', fetch)
    const addr = (i: number) => '0x' + i.toString(16).padStart(40, '0')
    for (let i = 0; i <= 5_000; i++) await g.getAddressRisk(addr(i))
    expect(fetch).toHaveBeenCalledTimes(5_001)
    await g.getAddressRisk(addr(5_000))   // newest: still cached
    expect(fetch).toHaveBeenCalledTimes(5_001)
    await g.getAddressRisk(addr(0))       // oldest: dropped
    expect(fetch).toHaveBeenCalledTimes(5_002)
  })
})
