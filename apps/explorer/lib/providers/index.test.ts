import { describe, expect, it } from 'vitest'
import { isBotRequest } from './index'

// resolveDataProvider's tests moved to packages/providers/src/registry.test.ts
// with the adapter (A4b-0). Bot detection stays here — it's about inbound web
// requests, which only the explorer has.
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
