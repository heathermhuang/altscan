import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Interface } from 'ethers'
import { BSC } from '@altscan/chain-config'
import { trackedTokens } from './holdings'
import { MULTICALL3, readTrackedBalances } from './tracked-balances'
import { resetSwallowThrottle } from './observability'

const iface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function balanceOf(address) view returns (uint256)',
])
const tokens = trackedTokens(BSC.whales)
const HOLDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3'

const reply = (balances: bigint[]) =>
  iface.encodeFunctionResult('aggregate3', [balances.map((b) => [true, iface.encodeFunctionResult('balanceOf', [b])])])

describe('readTrackedBalances', () => {
  it('reads every tracked token in ONE eth_call to Multicall3 and returns raw balances by address', async () => {
    const calls: { to: string; data: string }[] = []
    const provider = { call: async (tx: { to: string; data: string }) => { calls.push(tx); return reply([605_506_903n * 10n ** 18n, 0n, 7n]) } }
    const out = await readTrackedBalances(provider, HOLDER, tokens)
    expect(out).toEqual({ [tokens[0].address]: String(605_506_903n * 10n ** 18n), [tokens[1].address]: '0', [tokens[2].address]: '7' })
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toBe(MULTICALL3)
    // The batch asks each tracked token for the holder's balanceOf, and none may fail silently.
    const [batch] = iface.decodeFunctionData('aggregate3', calls[0].data)
    expect(batch.map((c: [string, boolean, string]) => c[0].toLowerCase())).toEqual(tokens.map((t) => t.address))
    expect(batch.every((c: [string, boolean, string]) => c[1] === false)).toBe(true)
    for (const c of batch as [string, boolean, string][]) {
      expect(c[2]).toBe(iface.encodeFunctionData('balanceOf', [HOLDER]))
    }
  })

  it('is null when the call fails: unknown is not zero', async () => {
    const provider = { call: async () => { throw new Error('rpc down') } }
    expect(await readTrackedBalances(provider, HOLDER, tokens)).toBeNull()
  })

  it('is null when the answer is not a multicall answer', async () => {
    expect(await readTrackedBalances({ call: async () => '0x' }, HOLDER, tokens)).toBeNull()
  })
})

// A failed read is "unknown" to the page, so the only record that the RPC is failing is the log. It used to be
// a bare `catch { return null }`: every failure rendered the plain lead sentence and left nothing to grep.
describe('readTrackedBalances logs what it swallows', () => {
  let err: ReturnType<typeof vi.spyOn>
  beforeEach(() => { resetSwallowThrottle(); err = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => err.mockRestore())
  const tags = () => err.mock.calls.map((c: unknown[]) => c[0])

  it('logs under [addr/tracked-balances] when the call fails', async () => {
    const provider = { call: async () => { throw new Error('rpc down') } }
    expect(await readTrackedBalances(provider, HOLDER, tokens)).toBeNull()
    expect(tags()).toEqual(['[addr/tracked-balances]'])
    expect(String(err.mock.calls[0][1])).toContain('rpc down')
  })

  it('logs when the answer cannot be decoded', async () => {
    expect(await readTrackedBalances({ call: async () => '0x' }, HOLDER, tokens)).toBeNull()
    expect(tags()).toEqual(['[addr/tracked-balances]'])
  })

  it('logs when the answer has the wrong number of results', async () => {
    expect(await readTrackedBalances({ call: async () => reply([1n, 2n]) }, HOLDER, tokens)).toBeNull()
    expect(tags()).toEqual(['[addr/tracked-balances]'])
    expect(String(err.mock.calls[0][1])).toMatch(/2 results for 3 tokens/)
  })

  it('logs nothing when the read works', async () => {
    expect(await readTrackedBalances({ call: async () => reply([1n, 2n, 3n]) }, HOLDER, tokens)).not.toBeNull()
    expect(err).not.toHaveBeenCalled()
  })
})
