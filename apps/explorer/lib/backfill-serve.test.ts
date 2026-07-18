import { describe, expect, it } from 'vitest'
import { encodeCursor, decodeCursor, txToHistoryRow } from './backfill-serve'

/**
 * The cursor codec encodes WHICH SOURCE the next page comes from. Getting this
 * wrong is not a rendering bug — a `local` cursor that decodes as `head` silently
 * restarts pagination at page 1, and a garbage cursor that decodes as `local`
 * serves cached rows where the user expected live ones.
 */
describe('backfill cursor codec', () => {
  it('round-trips a local keyset cursor', () => {
    const c = encodeCursor({ source: 'local', blockNumber: 25526988, txHash: '0xabc' })
    expect(decodeCursor(c)).toEqual({ source: 'local', blockNumber: 25526988, txHash: '0xabc' })
  })

  it('round-trips a local cursor carrying a logIndex (token transfers)', () => {
    const c = encodeCursor({ source: 'local', blockNumber: 42, txHash: '0xdef', logIndex: 7 })
    expect(decodeCursor(c)).toEqual({ source: 'local', blockNumber: 42, txHash: '0xdef', logIndex: 7 })
  })

  it('round-trips a provider passthrough cursor', () => {
    const c = encodeCursor({ source: 'provider', providerCursor: 'eyIx' })
    expect(decodeCursor(c)).toEqual({ source: 'provider', providerCursor: 'eyIx' })
  })

  // R1: the head is ALWAYS live. Nothing may decode to a local first page.
  it('treats a null/undefined/garbage cursor as the live head', () => {
    expect(decodeCursor(null)).toEqual({ source: 'head' })
    expect(decodeCursor(undefined)).toEqual({ source: 'head' })
    expect(decodeCursor('not-base64-json')).toEqual({ source: 'head' })
    expect(decodeCursor('')).toEqual({ source: 'head' })
  })

  it('rejects a local cursor missing its keyset boundary', () => {
    // Without both parts the keyset predicate is meaningless; falling back to
    // the live head is the only safe reading.
    const noBoundary = Buffer.from(JSON.stringify({ source: 'local' }), 'utf8').toString('base64url')
    const halfBoundary = Buffer.from(JSON.stringify({ source: 'local', blockNumber: 1 }), 'utf8').toString('base64url')
    expect(decodeCursor(noBoundary)).toEqual({ source: 'head' })
    expect(decodeCursor(halfBoundary)).toEqual({ source: 'head' })
  })

  it('rejects a provider cursor with no provider string, and unknown sources', () => {
    const noCur = Buffer.from(JSON.stringify({ source: 'provider' }), 'utf8').toString('base64url')
    const bogus = Buffer.from(JSON.stringify({ source: 'wat', blockNumber: 1 }), 'utf8').toString('base64url')
    expect(decodeCursor(noCur)).toEqual({ source: 'head' })
    expect(decodeCursor(bogus)).toEqual({ source: 'head' })
  })

  it('rejects a non-object payload', () => {
    for (const v of ['null', '42', '"str"', '[]']) {
      expect(decodeCursor(Buffer.from(v, 'utf8').toString('base64url'))).toEqual({ source: 'head' })
    }
  })
})

describe('txToHistoryRow', () => {
  it('projects exactly the served fields and fabricates nothing', () => {
    const row = txToHistoryRow({
      hash: '0x1', blockNumber: '10', blockTimestamp: '2026-07-18T00:00:00Z',
      fromAddress: '0xa', toAddress: '0xb', value: '5',
      gasPrice: '99', gasUsed: '21000',
      category: 'send', summary: 'Sent 5', possibleSpam: false,
      erc20Transfers: [{ tokenSymbol: 'X', contractAddress: '0xc', valueFormatted: '1', direction: 'send' }],
    } as never)

    expect(row).toEqual({
      hash: '0x1', blockNumber: '10', blockTimestamp: '2026-07-18T00:00:00Z',
      fromAddress: '0xa', toAddress: '0xb', value: '5',
      category: 'send', summary: 'Sent 5', possibleSpam: false,
    })
    // The whole point of the HistoryRow projection: no gas/erc20 leakage, so a
    // backfilled row and a provider row are indistinguishable to the client and
    // neither has to invent gasPrice:'0'.
    expect('gasPrice' in row).toBe(false)
    expect('erc20Transfers' in row).toBe(false)
  })
})
