import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchFacts = vi.hoisted(() => vi.fn())
vi.mock('./rpc-fallback', () => ({ fetchTxFactsFromRpc: fetchFacts }))

import { lookupTxOnChain, __resetTxLookupForTests } from './api-tx-lookup'

const hashOf = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const facts = (over: Record<string, unknown> = {}) => ({
  hash: hashOf(1), blockNumber: 100, fromAddress: '0xa', toAddress: '0xb', value: 1n, gas: 21000n,
  gasPrice: 1n, gasUsed: 21000n, input: '0x', status: true, pending: false, methodId: null,
  txIndex: 0, nonce: 0, txType: 2, timestamp: new Date(Date.now() - 86_400_000), ...over,
})

beforeEach(() => {
  fetchFacts.mockReset()
  __resetTxLookupForTests()
})
afterEach(() => { vi.useRealTimers() })

describe('lookupTxOnChain', () => {
  it('reports a transaction the node returns', async () => {
    fetchFacts.mockResolvedValue(facts())
    expect((await lookupTxOnChain(hashOf(1))).kind).toBe('found')
  })

  it('reports missing only when the node answers null', async () => {
    fetchFacts.mockResolvedValue(null)
    expect(await lookupTxOnChain(hashOf(2))).toEqual({ kind: 'missing' })
  })

  it('reports a failed node call as unavailable, never as missing', async () => {
    fetchFacts.mockRejectedValue(new Error('server response 500'))
    expect(await lookupTxOnChain(hashOf(3))).toEqual({ kind: 'unavailable' })
  })

  it('gives up at the deadline instead of holding the request open', async () => {
    vi.useFakeTimers()
    let release!: (v: unknown) => void
    fetchFacts.mockReturnValue(new Promise((r) => { release = r }))
    const p = lookupTxOnChain(hashOf(4))
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await p).toEqual({ kind: 'unavailable' })
    release(null) // the node call settles later, as the provider's own timeout guarantees
    await vi.advanceTimersByTimeAsync(0)
  })

  it('shares one node lookup between concurrent requests for the same hash', async () => {
    let release!: (v: unknown) => void
    fetchFacts.mockReturnValue(new Promise((r) => { release = r }))
    const a = lookupTxOnChain(hashOf(5).toUpperCase().replace('0X', '0x'))
    const b = lookupTxOnChain(hashOf(5))
    release(facts())
    expect((await a).kind).toBe('found')
    expect((await b).kind).toBe('found')
    expect(fetchFacts).toHaveBeenCalledTimes(1)
  })

  // Anyone can send random hashes, and each unknown one costs RPC calls.
  it('caps concurrent node lookups under a flood of unique hashes, refusing the rest', async () => {
    const releases: Array<(v: unknown) => void> = []
    fetchFacts.mockImplementation(() => new Promise((r) => { releases.push(r) }))
    const results = Array.from({ length: 50 }, (_, i) => lookupTxOnChain(hashOf(1000 + i)))
    expect(fetchFacts).toHaveBeenCalledTimes(8)
    for (const r of releases) r(null)
    const kinds = (await Promise.all(results)).map((r) => r.kind)
    expect(kinds.filter((k) => k === 'unavailable')).toHaveLength(42)
    expect(kinds.filter((k) => k === 'missing')).toHaveLength(8)
  })

  it('frees a slot only when a timed-out node call actually settles', async () => {
    vi.useFakeTimers()
    const releases: Array<(v: unknown) => void> = []
    fetchFacts.mockImplementation(() => new Promise((r) => { releases.push(r) }))
    const first = Array.from({ length: 8 }, (_, i) => lookupTxOnChain(hashOf(2000 + i)))
    await vi.advanceTimersByTimeAsync(8_000)
    await Promise.all(first) // all timed out, but their RPC calls are still running
    expect(await lookupTxOnChain(hashOf(2100))).toEqual({ kind: 'unavailable' })
    expect(fetchFacts).toHaveBeenCalledTimes(8)
    for (const r of releases) r(null)
    await vi.advanceTimersByTimeAsync(0)
    fetchFacts.mockResolvedValue(null)
    expect(await lookupTxOnChain(hashOf(2101))).toEqual({ kind: 'missing' })
  })

  it('lets a retry after the deadline share the still-running node call', async () => {
    vi.useFakeTimers()
    let release!: (v: unknown) => void
    fetchFacts.mockReturnValue(new Promise((r) => { release = r }))
    const first = lookupTxOnChain(hashOf(3000))
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await first).toEqual({ kind: 'unavailable' })
    const retry = lookupTxOnChain(hashOf(3000))
    release(facts({ hash: hashOf(3000) }))
    expect((await retry).kind).toBe('found')
    expect(fetchFacts).toHaveBeenCalledTimes(1)
  })

  it('caches a settled transaction, but not a pending or freshly mined one', async () => {
    fetchFacts.mockResolvedValue(facts())
    await lookupTxOnChain(hashOf(6))
    await lookupTxOnChain(hashOf(6))
    expect(fetchFacts).toHaveBeenCalledTimes(1)

    fetchFacts.mockClear()
    fetchFacts.mockResolvedValue(facts({ pending: true, status: null, gasUsed: null, blockNumber: null, timestamp: null }))
    await lookupTxOnChain(hashOf(7))
    await lookupTxOnChain(hashOf(7))
    expect(fetchFacts).toHaveBeenCalledTimes(2)

    fetchFacts.mockClear()
    fetchFacts.mockResolvedValue(facts({ timestamp: new Date() })) // could still be reorged out
    await lookupTxOnChain(hashOf(8))
    await lookupTxOnChain(hashOf(8))
    expect(fetchFacts).toHaveBeenCalledTimes(2)
  })
})
