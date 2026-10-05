import { describe, expect, it } from 'vitest'
import { Interface, encodeBytes32String } from 'ethers'
import {
  HEAL_RETRY_MS, UNKNOWN_NAME, UNKNOWN_SYMBOL,
  fetchTokenMetadata, planHeal, pruneTried, selectHealBatch,
  type CallRunner, type HealRow, type TokenMetadata,
} from './token-metadata'

const TOKEN = '0x55d398326f99059ff775485246999027b3197955'
const stringAbi = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])
const selector = (fn: string) => stringAbi.getFunction(fn)!.selector

type Reply = string | Error
/** A provider that answers each selector from `replies` and counts the calls. */
function mockRunner(replies: Partial<Record<'name' | 'symbol' | 'decimals' | 'totalSupply', Reply>>) {
  const bySelector = new Map(Object.entries(replies).map(([fn, r]) => [selector(fn), r as Reply]))
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const runner: CallRunner = {
    async call({ to, data }) {
      calls.push(`${to}:${data}`)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
      const reply = bySelector.get(data.slice(0, 10))
      if (reply === undefined) throw new Error('unexpected selector')
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return { runner, calls, maxInFlight: () => maxInFlight }
}

const encode = (fn: string, value: unknown) => stringAbi.encodeFunctionResult(fn, [value])
const revert = () => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' })
const rateLimited = () => Object.assign(
  new Error('method eth_call in batch triggered rate limit'), { code: 'SERVER_ERROR' })

describe('fetchTokenMetadata', () => {
  it('decodes the string ABI', async () => {
    const { runner } = mockRunner({
      name: encode('name', 'Tether USD'),
      symbol: encode('symbol', 'USDT'),
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 10n ** 27n),
    })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: 'Tether USD', symbol: 'USDT', decimals: 18, totalSupply: (10n ** 27n).toString(),
    })
  })

  it('falls back to bytes32 for name and symbol (MKR)', async () => {
    const { runner, calls } = mockRunner({
      name: encodeBytes32String('Maker'),
      symbol: encodeBytes32String('MKR'),
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 1n),
    })
    const meta = await fetchTokenMetadata(runner, TOKEN)
    expect(meta.name).toBe('Maker')
    expect(meta.symbol).toBe('MKR')
    // name() and symbol() share one selector across both ABIs, so the fallback is a decode, not a retry.
    expect(calls).toHaveLength(4)
  })

  it('accepts a bytes32 that fills all 32 bytes (no NUL terminator)', async () => {
    const full = 'A'.repeat(32)
    const { runner } = mockRunner({
      name: '0x' + Buffer.from(full).toString('hex'),
      symbol: encodeBytes32String('X'),
      decimals: encode('decimals', 6),
      totalSupply: encode('totalSupply', 5n),
    })
    expect((await fetchTokenMetadata(runner, TOKEN)).name).toBe(full)
  })

  it('leaves a bytes32 that is not UTF-8 unresolved instead of storing garbage', async () => {
    const { runner } = mockRunner({
      name: '0xff' + 'fe'.repeat(31),
      symbol: '0x' + '00'.repeat(31) + '40', // a number, not left-aligned text
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 1n),
    })
    const meta = await fetchTokenMetadata(runner, TOKEN)
    expect(meta.name).toBeNull()
    expect(meta.symbol).toBeNull()
  })

  it('returns null for a field whose call reverts, and keeps the others', async () => {
    const { runner } = mockRunner({
      name: revert(),
      symbol: encode('symbol', 'USDT'),
      decimals: revert(),
      totalSupply: revert(),
    })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: null, symbol: 'USDT', decimals: null, totalSupply: null,
    })
  })

  it('returns null, not a throw, when the endpoint rate-limits every call', async () => {
    const { runner, calls } = mockRunner({
      name: rateLimited(), symbol: rateLimited(), decimals: rateLimited(), totalSupply: rateLimited(),
    })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: null, symbol: null, decimals: null, totalSupply: null,
    })
    // No hidden retry on the throttled endpoint.
    expect(calls).toHaveLength(4)
  })

  it('treats empty return data (an address with no code) as unresolved', async () => {
    const { runner } = mockRunner({ name: '0x', symbol: '0x', decimals: '0x', totalSupply: '0x' })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: null, symbol: null, decimals: null, totalSupply: null,
    })
  })

  it('strips control bytes and truncates like sanitizeTokenMetadata did', async () => {
    const { runner } = mockRunner({
      name: encode('name', 'Bad\u0000Token\u0007' + 'x'.repeat(300)),
      symbol: encode('symbol', 'S'.repeat(80)),
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 1n),
    })
    const meta = await fetchTokenMetadata(runner, TOKEN)
    expect(meta.name).toHaveLength(255)
    expect(meta.name!.startsWith('BadToken')).toBe(true)
    expect(meta.symbol).toHaveLength(50)
  })

  it('treats a blank name as unresolved so the caller picks the placeholder', async () => {
    const { runner } = mockRunner({
      name: encode('name', '\u0000 \u0007'),
      symbol: encode('symbol', ''),
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 0n),
    })
    const meta = await fetchTokenMetadata(runner, TOKEN)
    expect(meta.name ?? UNKNOWN_NAME).toBe('Unknown')
    expect(meta.symbol ?? UNKNOWN_SYMBOL).toBe('???')
    expect(meta.totalSupply).toBe('0')
  })

  it('fires the four calls together by default and one at a time when sequential', async () => {
    const replies = {
      name: encode('name', 'A'), symbol: encode('symbol', 'A'),
      decimals: encode('decimals', 18), totalSupply: encode('totalSupply', 1n),
    }
    const together = mockRunner(replies)
    await fetchTokenMetadata(together.runner, TOKEN)
    expect(together.maxInFlight()).toBe(4)

    const serial = mockRunner(replies)
    await fetchTokenMetadata(serial.runner, TOKEN, { sequential: true })
    expect(serial.maxInFlight()).toBe(1)
  })
})

const meta = (over: Partial<TokenMetadata> = {}): TokenMetadata =>
  ({ name: 'Tether USD', symbol: 'USDT', decimals: 18, totalSupply: '1000', ...over })
const row = (over: Partial<HealRow> = {}): HealRow => ({
  address: TOKEN, name: UNKNOWN_NAME, symbol: UNKNOWN_SYMBOL, decimals: 18,
  totalSupply: '0', type: 'BEP20', holderCount: 835_871, ...over,
})

describe('planHeal', () => {
  it('writes every field that resolved over a placeholder', () => {
    expect(planHeal(row(), meta({ decimals: 6 }))).toEqual({
      name: 'Tether USD', symbol: 'USDT', totalSupply: '1000', decimals: 6,
    })
  })

  it('never overwrites a real value, and a failed fetch writes nothing', () => {
    expect(planHeal(row(), meta({ name: null, symbol: null, decimals: null, totalSupply: null }))).toBeNull()
    // Real name and supply are left alone even if the chain now says something else.
    const real = row({ name: 'Real Name', totalSupply: '5' })
    expect(planHeal(real, meta({ name: 'Other', totalSupply: '9' }))).toEqual({ symbol: 'USDT' })
  })

  it('does not treat the placeholder itself as a resolved value', () => {
    expect(planHeal(row(), meta({ name: UNKNOWN_NAME, symbol: UNKNOWN_SYMBOL, totalSupply: '0' }))).toBeNull()
  })

  it('heals an empty-string name or symbol', () => {
    expect(planHeal(row({ name: '', symbol: '' }), meta({ totalSupply: '0' }))).toEqual({
      name: 'Tether USD', symbol: 'USDT',
    })
  })

  it('leaves a genuinely zero supply alone', () => {
    const r = row({ name: 'Real', symbol: 'RL' })
    expect(planHeal(r, meta({ totalSupply: '0' }))).toBeNull()
  })

  it('corrects decimals on their own, since they are immutable on chain', () => {
    const r = row({ name: 'Real', symbol: 'RL', totalSupply: '7' })
    expect(planHeal(r, meta({ decimals: 8 }))).toEqual({ decimals: 8 })
    expect(planHeal(r, meta({ decimals: 18 }))).toBeNull()
  })
})

describe('selectHealBatch / pruneTried', () => {
  const NOW = 10 * HEAL_RETRY_MS
  const rows = ['0xa', '0xb', '0xc', '0xd'].map(address => ({ address }))

  it('skips addresses tried inside the window and keeps holder order', () => {
    const tried = new Map([['0xa', NOW - 1000], ['0xc', NOW - HEAL_RETRY_MS + 1]])
    expect(selectHealBatch(rows, tried, NOW, 10).map(r => r.address)).toEqual(['0xb', '0xd'])
  })

  it('retries an address once its window has passed', () => {
    const tried = new Map([['0xa', NOW - HEAL_RETRY_MS]])
    expect(selectHealBatch(rows, tried, NOW, 1).map(r => r.address)).toEqual(['0xa'])
  })

  it('stops at the batch size', () => {
    expect(selectHealBatch(rows, new Map(), NOW, 2).map(r => r.address)).toEqual(['0xa', '0xb'])
  })

  it('prunes only the expired entries', () => {
    const tried = new Map([['0xa', NOW - HEAL_RETRY_MS], ['0xb', NOW - 1]])
    pruneTried(tried, NOW)
    expect([...tried.keys()]).toEqual(['0xb'])
  })
})
