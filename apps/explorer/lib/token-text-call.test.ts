import { describe, expect, it } from 'vitest'
import { AbiCoder, JsonRpcProvider, Network } from 'ethers'
import {
  isDefinitiveRevert, readTokenNameAndSymbol, readTokenText, TOKEN_NAME_MAX, TOKEN_SYMBOL_MAX, TOKEN_TEXT_MAX_RETURN_BYTES,
} from './token-text-call'

const TOKEN = '0x' + '12'.repeat(20)
const enc = (s: string) => AbiCoder.defaultAbiCoder().encode(['string'], [s])
const answering = (raw: string | ((data: string) => string)) => ({
  call: async (tx: { to: string; data: string }) => (typeof raw === 'string' ? raw : raw(tx.data)),
})

/** The error ethers itself builds from this JSON-RPC error body, not a hand-made lookalike. */
async function ethersCallError(error: { code: number; message: string; data?: string }): Promise<unknown> {
  const net = Network.from(56)
  class Endpoint extends JsonRpcProvider {
    async _send(payload: unknown) {
      return ((Array.isArray(payload) ? payload : [payload]) as Array<{ id: number }>).map(r => ({ id: r.id, error })) as never
    }
  }
  const p = new Endpoint('http://endpoint.invalid', net, { staticNetwork: net, batchMaxCount: 1 })
  return p.call({ to: TOKEN, data: '0x06fdde03' }).then(() => { throw new Error('expected a rejection') }, (e: unknown) => e)
}
const failing = (err: unknown) => ({ call: async () => { throw err } })

describe('readTokenText', () => {
  it('decodes an ABI string', async () => {
    expect(await readTokenText(answering(enc('Tether USD')), TOKEN, 'name')).toEqual({ settled: true, text: 'Tether USD' })
  })

  it('asks for the function it was asked for', async () => {
    const caller = answering((data) => enc(data === '0x06fdde03' ? 'the name' : 'the symbol'))
    expect(await readTokenText(caller, TOKEN, 'symbol')).toEqual({ settled: true, text: 'the symbol' })
  })

  // A contract chooses its return size; this read refuses one past the bound before decoding anything.
  it('gives no text for return data past the bound, and keeps a 255-character name, which fits', async () => {
    const long = enc('x'.repeat(5_000))
    expect((long.length - 2) / 2).toBeGreaterThan(TOKEN_TEXT_MAX_RETURN_BYTES)
    expect(await readTokenText(answering(long), TOKEN, 'name')).toEqual({ settled: true, text: null })
    const fits = 'y'.repeat(TOKEN_NAME_MAX)
    expect(await readTokenText(answering(enc(fits)), TOKEN, 'name')).toEqual({ settled: true, text: fits })
  })

  it('settles on no text for an empty return, an empty string, or data that is not an ABI string', async () => {
    expect(await readTokenText(answering('0x'), TOKEN, 'name')).toEqual({ settled: true, text: null })
    expect(await readTokenText(answering(enc('')), TOKEN, 'name')).toEqual({ settled: true, text: null })
    const bytes32 = '0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')
    expect(await readTokenText(answering(bytes32), TOKEN, 'symbol')).toEqual({ settled: true, text: null })
  })

  it('settles on a revert, which the contract repeats', async () => {
    const reverted = await ethersCallError({ code: 3, message: 'execution reverted' })
    expect(isDefinitiveRevert(reverted)).toBe(true)
    expect(await readTokenText(failing(reverted), TOKEN, 'name')).toEqual({ settled: true, text: null })
  })

  // ethers reports a node's rate limit as CALL_EXCEPTION too; caching it would hide the token's name for the TTL.
  it('does not settle on a rate limit dressed as a CALL_EXCEPTION, or a timeout', async () => {
    const throttled = await ethersCallError({ code: -32005, message: 'method eth_call in batch triggered rate limit' })
    expect((throttled as { code: string }).code).toBe('CALL_EXCEPTION')
    expect(isDefinitiveRevert(throttled)).toBe(false)
    expect((await readTokenText(failing(throttled), TOKEN, 'name')).settled).toBe(false)
    const timeout = Object.assign(new Error('request timeout'), { code: 'TIMEOUT' })
    expect((await readTokenText(failing(timeout), TOKEN, 'name')).settled).toBe(false)
  })
})

describe('readTokenNameAndSymbol', () => {
  it('caps the name at 255 and the symbol at 50 characters, as the indexer stores them', async () => {
    const caller = answering((data) => enc(data === '0x06fdde03' ? 'n'.repeat(300) : 's'.repeat(80)))
    const { name, symbol } = await readTokenNameAndSymbol(caller, TOKEN)
    expect(name).toBe('n'.repeat(TOKEN_NAME_MAX))
    expect(symbol).toBe('s'.repeat(TOKEN_SYMBOL_MAX))
  })

  it('gives null for a side that failed or has no text', async () => {
    expect(await readTokenNameAndSymbol(failing(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), TOKEN))
      .toEqual({ name: null, symbol: null })
  })
})
