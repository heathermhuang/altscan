import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeError } from 'ethers'

// The risk signals are read off a `contracts` row, which exists only after a Sourcify verify, plus one owner() call.
// A signal that could not be checked (no ABI, a node that did not answer) must never come out as a pass: "No mint
// function detected" with a green check, on a token whose ABI nobody read, is a claim the explorer did not earn.
const TOKEN = '0x' + 'a'.repeat(40)
const h = vi.hoisted(() => ({
  contract: null as Record<string, unknown> | null,
  call: (async () => '0x') as () => Promise<string>,
}))

vi.mock('@/lib/db', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['from', 'where']) query[m] = () => query
  query.then = (resolve: (r: unknown) => unknown) => resolve(h.contract ? [h.contract] : [])
  return { db: { select: () => query }, schema: { contracts: {} } }
})
vi.mock('@/lib/rpc', () => ({ getWebProvider: async () => ({ call: () => h.call() }) }))

const revert = () => makeError('execution reverted', 'CALL_EXCEPTION', { action: 'call', data: null, reason: null, transaction: { to: TOKEN, data: '0x' }, invocation: null, revert: null })
const OWNER_RENOUNCED = '0x' + '0'.repeat(64)
const fn = (name: string) => ({ type: 'function', name })
const verified = (abi: unknown) => ({ address: TOKEN, verifiedAt: new Date(), abi })

const run = async () => (await import('./token-risk')).analyzeTokenRisk(TOKEN)
const byLabel = async () => Object.fromEntries((await run()).map((s) => [s.label, s]))

beforeEach(() => {
  h.contract = null
  h.call = async () => '0x'
})

describe('analyzeTokenRisk with no verified ABI', () => {
  it('reports mint, blacklist, proxy and a failed owner() read as not checked, never as passes', async () => {
    h.call = async () => { throw new Error('network down') }
    const signals = await run()
    const checks = signals.filter((s) => s.label !== 'Source Verified')
    expect(checks.map((s) => s.label)).toEqual(['Mint Function', 'Blacklist', 'Proxy/Upgradeable', 'Ownership'])
    for (const s of checks) {
      expect(s.unknown).toBe(true)
      expect(s.ok).toBe(false)
    }
    // No signal may pass while claiming something was looked for and not found.
    expect(signals.filter((s) => s.ok && /^No .* detected|^Not a proxy/.test(s.description))).toEqual([])
    expect(signals.filter((s) => s.unknown).map((s) => s.description)).toEqual([
      'No verified ABI, so this was not checked',
      'No verified ABI, so this was not checked',
      'No verified ABI, so this was not checked',
      'The node did not answer, so this was not checked',
    ])
  })

  it('treats an ABI that is not a list (a legacy double-encoded jsonb string) or lists no function as no ABI', async () => {
    for (const abi of ['[{"type":"function","name":"mint"}]', [], [{ type: 'event', name: 'Transfer' }]]) {
      h.contract = verified(abi)
      const s = await byLabel()
      expect([s['Mint Function'].unknown, s['Blacklist'].unknown, s['Proxy/Upgradeable'].unknown]).toEqual([true, true, true])
    }
  })

  it('a timeout is not an answer either', async () => {
    h.call = async () => { throw makeError('timeout', 'TIMEOUT', { operation: 'call', reason: 'timeout' }) }
    expect((await byLabel())['Ownership'].unknown).toBe(true)
  })
})

describe('analyzeTokenRisk owner()', () => {
  it('a revert means the contract answered: no ownable pattern, a real pass', async () => {
    h.call = async () => { throw revert() }
    const s = (await byLabel())['Ownership']
    expect(s).toMatchObject({ ok: true, description: 'No ownable pattern detected' })
    expect(s.unknown).toBeUndefined()
  })

  it('an empty return ethers cannot decode is also an answer', async () => {
    h.call = async () => '0x'
    expect((await byLabel())['Ownership']).toMatchObject({ ok: true, description: 'No ownable pattern detected' })
  })

  it('a renounced owner is still read', async () => {
    h.call = async () => OWNER_RENOUNCED
    expect((await byLabel())['Ownership Renounced']).toMatchObject({ ok: true })
  })
})

describe('analyzeTokenRisk with a verified ABI', () => {
  it('still passes the checks the ABI answers: no mint, no blacklist, not a proxy', async () => {
    h.contract = verified([fn('transfer'), fn('balanceOf')])
    const s = await byLabel()
    expect(s['Mint Function']).toMatchObject({ ok: true, description: 'No mint function detected' })
    expect(s['Blacklist']).toMatchObject({ ok: true, description: 'No blacklist function detected' })
    expect(s['Proxy/Upgradeable']).toMatchObject({ ok: true, description: 'Not a proxy contract' })
    expect(s['Mint Function'].unknown).toBeUndefined()
  })

  it('flags what the ABI contains', async () => {
    h.contract = verified([fn('mint'), fn('addToBlacklist'), fn('upgradeTo')])
    const s = await byLabel()
    expect([s['Mint Function'], s['Blacklist'], s['Proxy/Upgradeable']].map((x) => [x.ok, x.severity])).toEqual([
      [false, 'warn'], [false, 'warn'], [false, 'warn'],
    ])
  })
})
