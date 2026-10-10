import { describe, it, expect, vi } from 'vitest'

const kv = vi.hoisted(() => ({ keys: [] as string[] }))
vi.mock('@altscan/explorer-core', () => ({
  kvGet: async (key: string) => { kv.keys.push(key); return JSON.stringify({ priceUsd: 1, pairLabel: 'X/Y pair on Z' }) },
  kvSet: async () => {},
}))

import { buildMarketData, dexName, getTokenMarketData } from './market-data'

const pair = (dexId: string) => ({
  chainId: 'bsc', dexId, url: 'https://dexscreener.com/bsc/0xabc',
  baseToken: { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT' },
  quoteToken: { symbol: 'USDC' },
  priceUsd: '1.0002', volume: { h24: 250_000_000 }, liquidity: { usd: 110_000_000 },
})

// DexScreener's volume and liquidity are one pair's figures, not the token's. The page names the pair, from the
// pair's own tokens and DEX, so a reader cannot take a single pool's volume for the token's.
describe('market pair label', () => {
  it('names the base/quote tokens and the DEX', () => {
    expect(buildMarketData(pair('pancakeswap'), null).pairLabel).toBe('USDT/USDC pair on PancakeSwap')
    expect(buildMarketData(pair('uniswap'), null).pairLabel).toBe('USDT/USDC pair on Uniswap')
  })

  it('reads the DEX id the way DexScreener writes it', () => {
    expect(dexName('pancakeswap')).toBe('PancakeSwap')
    expect(dexName('pancakeswap-v3')).toBe('PancakeSwap')
    expect(dexName('biswap')).toBe('BiSwap')
    // An id we have no name for is still readable, never raw lowercase.
    expect(dexName('kyber-elastic')).toBe('Kyber Elastic')
    expect(dexName('')).toBe('')
  })

  it('names just the pair when DexScreener gave no DEX', () => {
    expect(buildMarketData(pair(''), null).pairLabel).toBe('USDT/USDC pair')
  })

  it('reads the cache under a key for the new label (the cached value changed meaning)', async () => {
    kv.keys.length = 0
    await getTokenMarketData('0xabc')
    expect(kv.keys).toEqual(['market:v2:bnb:0xabc'])
  })
})
