import { describe, expect, it } from 'vitest'
import { CHAINS } from './index'

describe('chain-config data provider', () => {
  it('BSC and ETH both configure a moralis data provider with their hex chain ids', () => {
    expect(CHAINS.bnb.provider).toEqual({ kind: 'moralis', moralisChain: '0x38' })
    expect(CHAINS.eth.provider).toEqual({ kind: 'moralis', moralisChain: '0x1' })
  })

  it('a chain with no provider is representable (forward-only indexing mode)', () => {
    const cfg = { ...CHAINS.bnb, provider: null }
    expect(cfg.provider).toBeNull()
  })

  it('moralisChain no longer exists as a top-level field (moved into provider)', () => {
    expect('moralisChain' in CHAINS.bnb).toBe(false)
    expect('moralisChain' in CHAINS.eth).toBe(false)
  })
})
