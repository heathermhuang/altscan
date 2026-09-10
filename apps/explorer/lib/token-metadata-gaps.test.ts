import { describe, expect, it } from 'vitest'
import { addrsNeedingMetadata, PLACEHOLDER_SYMBOL } from './token-metadata'

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
