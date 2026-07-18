import { describe, expect, it } from 'vitest'
import { resolveDataProvider } from './index'

describe('resolveDataProvider', () => {
  it('returns null when the chain configures no provider', () => {
    expect(resolveDataProvider(null)).toBeNull()
  })
  it('builds a moralis adapter from a moralis config', () => {
    const p = resolveDataProvider({ kind: 'moralis', moralisChain: '0x38' })
    expect(p?.kind).toBe('moralis')
  })
  it('threads host context (currency) through to the adapter', () => {
    const p = resolveDataProvider({ kind: 'moralis', moralisChain: '0x1' }, { currency: 'ETH' })
    expect(p?.kind).toBe('moralis')
  })
})
