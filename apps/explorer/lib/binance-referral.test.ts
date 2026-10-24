import { describe, it, expect } from 'vitest'
import { getChainConfig } from '@altscan/chain-config'
import { isStablecoinToken } from './binance-referral'

// The stablecoin CTA is for the chain's own stablecoins. It used to match the words "usdt", "dai", ... in the token's
// symbol or name, so anyone could earn it by naming a token "BabyUSDT" or "Daisy". It now asks the chain config.
const bnb = getChainConfig('bnb')
const eth = getChainConfig('eth')
const BNB_USDT = '0x55d398326f99059fF775485246999027B3197955'
const BNB_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
const ETH_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const SPAM = '0x00000000000000000000000000000000deadbeef'

describe('isStablecoinToken', () => {
  it('is true for the chain\'s configured stablecoins, in any address casing', () => {
    for (const a of [BNB_USDT, BNB_USDT.toLowerCase(), BNB_USDT.toUpperCase().replace('0X', '0x'), BNB_USDC]) {
      expect(isStablecoinToken(a, bnb), a).toBe(true)
    }
    expect(isStablecoinToken(ETH_USDT, eth)).toBe(true)
  })

  it('is false for a token that merely carries a stablecoin\'s name: only the contract counts', () => {
    // Nothing about a token but its address is passed in, so no name can earn the CTA.
    for (const address of [SPAM, '0x' + '1'.repeat(40)]) {
      expect(isStablecoinToken(address, bnb)).toBe(false)
      expect(isStablecoinToken(address, eth)).toBe(false)
    }
  })

  it('is false for a stablecoin\'s address on the OTHER chain', () => {
    expect(isStablecoinToken(BNB_USDT, eth)).toBe(false)
    expect(isStablecoinToken(ETH_USDT, bnb)).toBe(false)
  })
})
