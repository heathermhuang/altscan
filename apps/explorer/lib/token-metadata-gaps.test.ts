import { describe, expect, it } from 'vitest'
import { addrsNeedingMetadata, PLACEHOLDER_SYMBOL, recordFetchedMetadata, type KnownToken, type TokenMeta } from './token-metadata'
import { decodeTx } from './tx-decoder'

const known = (entries: [string, string][]) =>
  new Map(entries.map(([a, symbol]) => [a, { symbol }]))

describe('addrsNeedingMetadata', () => {
  it('includes an address with no local row', () => {
    expect(addrsNeedingMetadata(['0xaaa'], known([]))).toEqual(['0xaaa'])
  })
  it('includes an address whose stored symbol is the indexer placeholder', () => {
    expect(addrsNeedingMetadata(['0xaaa'], known([['0xaaa', PLACEHOLDER_SYMBOL]]))).toEqual(['0xaaa'])
  })
  it('excludes an address that already has a real symbol', () => {
    expect(addrsNeedingMetadata(['0xaaa'], known([['0xaaa', 'USDT']]))).toEqual([])
  })
})

// A contract that answered symbol() but not decimals() used to be recorded with decimals 18, which
// defeated decodeTx's "?" for an unknown amount: a 6-decimal token's amount printed a trillion
// times too small, as fact.
describe('recordFetchedMetadata', () => {
  const fetched = (entries: [string, TokenMeta][]) => new Map(entries)

  it('keeps a decimals the contract did not answer as null, never a guessed 18', () => {
    const lookup = new Map<string, KnownToken>([['0xaaa', { symbol: PLACEHOLDER_SYMBOL, decimals: 18 }]])
    recordFetchedMetadata(lookup, fetched([['0xaaa', { symbol: 'USDT', decimals: null }]]))
    expect(lookup.get('0xaaa')).toEqual({ symbol: 'USDT', decimals: null })
  })

  it('records a decimals the contract did answer, including 0', () => {
    const lookup = new Map<string, KnownToken>()
    recordFetchedMetadata(lookup, fetched([['0xaaa', { symbol: 'USDT', decimals: 6 }], ['0xbbb', { symbol: 'NFTX', decimals: 0 }]]))
    expect(lookup.get('0xaaa')).toEqual({ symbol: 'USDT', decimals: 6 })
    expect(lookup.get('0xbbb')).toEqual({ symbol: 'NFTX', decimals: 0 })
  })

  it('records a decimals-only answer with an empty symbol, and skips an answer with neither', () => {
    const lookup = new Map<string, KnownToken>()
    recordFetchedMetadata(lookup, fetched([['0xaaa', { symbol: null, decimals: 8 }], ['0xbbb', { symbol: null, decimals: null }]]))
    expect(lookup.get('0xaaa')).toEqual({ symbol: '', decimals: 8 })
    expect(lookup.has('0xbbb')).toBe(false)
  })

  it('a transfer of such a token reads its amount as ? in the headline', () => {
    const lookup = new Map<string, KnownToken>()
    recordFetchedMetadata(lookup, fetched([['0xaaa', { symbol: 'USDT', decimals: null }]]))
    const tok = lookup.get('0xaaa')!
    const out = decodeTx(
      { hash: '0xabc', fromAddress: '0x7830c87c02e56aff27fa8ab1241711331fa86f43', toAddress: '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', value: '0', methodId: '0xa9059cbb', status: true },
      [{ tokenAddress: '0xaaa', fromAddress: '0x7830c87c02e56aff27fa8ab1241711331fa86f43', toAddress: '0x1111111111111111111111111111111111111111', value: '4280000000', tokenSymbol: tok.symbol, tokenDecimals: tok.decimals ?? undefined }],
      'BNB',
    )
    expect(out.summary).toBe('Transferred ? USDT to 0x1111111111…')
  })
})
