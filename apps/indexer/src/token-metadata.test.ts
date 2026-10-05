import { describe, expect, it } from 'vitest'
import { Interface, JsonRpcProvider, Network, encodeBytes32String } from 'ethers'
import {
  HEAL_RETRY_MS, TRANSPORT_STREAK_LIMIT, UNKNOWN_NAME, UNKNOWN_SYMBOL,
  decideHeal, fetchTokenMetadata, isTransportError, planHeal, pruneTried, selectHealBatch,
  type CallRunner, type FetchedTokenMetadata, type HealRow, type TokenMetadata,
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
      transportFailed: false,
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
      name: null, symbol: 'USDT', decimals: null, totalSupply: null, transportFailed: false,
    })
  })

  it('returns null, not a throw, when the endpoint rate-limits every call', async () => {
    const { runner, calls } = mockRunner({
      name: rateLimited(), symbol: rateLimited(), decimals: rateLimited(), totalSupply: rateLimited(),
    })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: null, symbol: null, decimals: null, totalSupply: null, transportFailed: true,
    })
    // No hidden retry on the throttled endpoint.
    expect(calls).toHaveLength(4)
  })

  it('treats empty return data (an address with no code) as unresolved', async () => {
    const { runner } = mockRunner({ name: '0x', symbol: '0x', decimals: '0x', totalSupply: '0x' })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: null, symbol: null, decimals: null, totalSupply: null, transportFailed: false,
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

/** A real JsonRpcProvider whose endpoint answers every request with `respond`, so the
 *  errors under test are the ones ethers actually builds (not hand-made lookalikes). */
function endpoint(respond: () => { result?: string; error?: { code: number; message: string; data?: string } } | null) {
  const net = Network.from(56)
  class P extends JsonRpcProvider {
    async _send(payload: unknown) {
      const reqs = (Array.isArray(payload) ? payload : [payload]) as Array<{ id: number }>
      const out = reqs.map(r => ({ id: r.id, ...respond() }))
      return (respond() === null ? [] : out) as never
    }
  }
  return new P('http://endpoint.invalid', net, { staticNetwork: net, batchMaxCount: 1 })
}
const callOf = (p: JsonRpcProvider) => p.call({ to: TOKEN, data: '0x06fdde03' }).then(() => null, (e: unknown) => e)

describe('isTransportError', () => {
  it('reads a node rate limit out of the CALL_EXCEPTION ethers wraps it in', async () => {
    const err = await callOf(endpoint(() => ({ error: { code: -32005, message: 'method eth_call in batch triggered rate limit' } })))
    expect((err as { code: string }).code).toBe('CALL_EXCEPTION') // why the code alone is not enough
    expect(isTransportError(err)).toBe(true)
  })

  it('recognises -32005 on its own, whatever the message', () => {
    expect(isTransportError({ info: { error: { code: -32005, message: 'limit' } } })).toBe(true)
    expect(isTransportError({ error: { code: -32005, message: 'x' } })).toBe(true)
  })

  it.each([
    ['a rate-limit message under another code', { code: 'UNKNOWN_ERROR', message: 'method eth_call in batch triggered rate limit' }],
    ['"Too Many Requests"', { code: 'CALL_EXCEPTION', info: { error: { code: -32000, message: 'Too Many Requests' } } }],
    ['HTTP 429', { code: 'SERVER_ERROR', message: 'bad response (status=429, ...)' }],
    ['an ethers TIMEOUT', { code: 'TIMEOUT', message: 'request timeout' }],
    ['a timeout message', new Error('[rpc-failover] token-heal fetch timed out after 15000ms')],
    ['a network error', { code: 'NETWORK_ERROR', message: 'could not detect network' }],
    ['a connection reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
  ])('treats %s as transport', (_what, err) => expect(isTransportError(err)).toBe(true))

  it('treats a batch with no response for the request as transport', async () => {
    const err = await callOf(endpoint(() => null))
    expect((err as { code: string }).code).toBe('BAD_DATA')
    expect(isTransportError(err)).toBe(true)
  })

  it('treats a revert as the contract answering, with or without revert data', async () => {
    const withData = await callOf(endpoint(() => ({ error: { code: 3, message: 'execution reverted: nope', data: '0x08c379a0' + '00'.repeat(31) + '20' + '00'.repeat(31) + '00' } })))
    const noData = await callOf(endpoint(() => ({ error: { code: 3, message: 'execution reverted' } })))
    expect((withData as { code: string }).code).toBe('CALL_EXCEPTION')
    expect(isTransportError(withData)).toBe(false)
    expect(isTransportError(noData)).toBe(false)
  })

  it('does not let a revert reason that mentions rate limits count as transport', () => {
    expect(isTransportError({
      code: 'CALL_EXCEPTION',
      message: 'execution reverted: rate limit exceeded',
      info: { error: { code: 3, message: 'execution reverted: rate limit exceeded', data: '0x08c379a0aa' } },
    })).toBe(false)
  })

  it('treats bad data, empty returns and an invalid opcode as the contract answering', async () => {
    expect(isTransportError({ code: 'BAD_DATA', shortMessage: 'could not decode result data' })).toBe(false)
    const opcode = await callOf(endpoint(() => ({ error: { code: -32000, message: 'invalid opcode: INVALID' } })))
    expect(isTransportError(opcode)).toBe(false)
  })

  it('does not guess: an unrecognised error is not transport', () => {
    // Misreading a permanently odd contract as transport would retry it first on
    // every run and stop the healer each time.
    expect(isTransportError(new Error('something unexpected'))).toBe(false)
    expect(isTransportError('boom')).toBe(false)
    expect(isTransportError(null)).toBe(false)
  })
})

describe('fetchTokenMetadata transportFailed', () => {
  const answers = {
    name: encode('name', 'Tether USD'), symbol: encode('symbol', 'USDT'),
    decimals: encode('decimals', 18), totalSupply: encode('totalSupply', 1n),
  }

  it('is set when any one field was throttled, and the rest still resolve', async () => {
    const { runner } = mockRunner({ ...answers, symbol: rateLimited() })
    const meta = await fetchTokenMetadata(runner, TOKEN, { sequential: true })
    expect(meta.transportFailed).toBe(true)
    expect(meta.name).toBe('Tether USD')
    expect(meta.symbol).toBeNull()
  })

  it('is set for a rate limit as a real provider reports it', async () => {
    const p = endpoint(() => ({ error: { code: -32005, message: 'method eth_call in batch triggered rate limit' } }))
    const meta = await fetchTokenMetadata(p, TOKEN)
    expect(meta).toMatchObject({ name: null, symbol: null, decimals: null, totalSupply: null, transportFailed: true })
  })

  it('is not set when the contract reverts or returns nothing', async () => {
    const reverting = await fetchTokenMetadata(mockRunner({ name: revert(), symbol: revert(), decimals: revert(), totalSupply: revert() }).runner, TOKEN)
    const empty = await fetchTokenMetadata(mockRunner({ name: '0x', symbol: '0x', decimals: '0x', totalSupply: '0x' }).runner, TOKEN)
    expect(reverting.transportFailed).toBe(false)
    expect(empty.transportFailed).toBe(false)
  })
})

describe('decideHeal', () => {
  const fetched = (over: Partial<FetchedTokenMetadata> = {}): FetchedTokenMetadata =>
    ({ ...meta(), transportFailed: false, ...over })
  const dark = { name: null, symbol: null, decimals: null, totalSupply: null }

  it('does not mark a rate-limited token tried, so the next tick retries it', () => {
    const step = decideHeal(row(), fetched({ ...dark, transportFailed: true }), 0)
    expect(step).toMatchObject({ patch: null, markTried: false, transportFailed: true })
  })

  it('marks a token tried when the contract reverted, and writes nothing', () => {
    const step = decideHeal(row(), fetched({ ...dark, transportFailed: false }), 0)
    expect(step).toMatchObject({ patch: null, markTried: true, transportFailed: false })
  })

  it('still writes what resolved on a partial transport failure, but retries the token', () => {
    const step = decideHeal(row(), fetched({ symbol: null, transportFailed: true }), 0)
    expect(step.patch).toMatchObject({ name: 'Tether USD' })
    expect(step.patch).not.toHaveProperty('symbol')
    expect(step.markTried).toBe(false)
  })

  it('treats a timed-out fetch (no result at all) as a transport failure', () => {
    expect(decideHeal(row(), null, 0)).toMatchObject({ patch: null, markTried: false, transportFailed: true })
  })

  it('stops after the streak limit of consecutive transport failures, and a real answer resets it', () => {
    const failing = fetched({ ...dark, transportFailed: true })
    let streak = 0
    const stops: boolean[] = []
    for (let i = 0; i < TRANSPORT_STREAK_LIMIT; i++) {
      const step = decideHeal(row(), failing, streak)
      streak = step.streak
      stops.push(step.stop)
    }
    expect(TRANSPORT_STREAK_LIMIT).toBe(3)
    expect(stops).toEqual([false, false, true])

    const answered = decideHeal(row(), fetched({ ...dark }), 2)
    expect(answered).toMatchObject({ streak: 0, stop: false })
    expect(decideHeal(row(), failing, answered.streak).stop).toBe(false)
  })
})
