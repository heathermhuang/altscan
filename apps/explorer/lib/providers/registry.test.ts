import { describe, expect, it } from 'vitest'
import { isBotRequest, resolveDataProvider } from './index'

describe('resolveDataProvider', () => {
  it('returns null when the chain configures no provider', () => {
    expect(resolveDataProvider(null)).toBeNull()
  })
  it('builds a moralis adapter from a moralis config', () => {
    const p = resolveDataProvider({ kind: 'moralis', moralisChain: '0x38' })
    expect(p?.kind).toBe('moralis')
  })
})

describe('isBotRequest', () => {
  it('flags crawlers and user-triggered AI fetchers', () => {
    expect(isBotRequest('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true)
    expect(isBotRequest('ChatGPT-User/1.0')).toBe(true)
  })
  it('passes real browsers and null UA', () => {
    expect(isBotRequest('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe(false)
    expect(isBotRequest(null)).toBe(false)
  })
})
