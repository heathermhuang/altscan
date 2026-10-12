import { describe, expect, it } from 'vitest'
import { adReserveVariant } from './ad-reserve'

// The hosted explorers set BINANCE_REF_CODE; a fresh fork does not.
const HOSTED = { BINANCE_REF_CODE: 'BNBSCAN' } as unknown as NodeJS.ProcessEnv
const FORK = {} as NodeJS.ProcessEnv

describe('adReserveVariant', () => {
  it('reserves every in-flow variant when settings are absent (defaults: all enabled)', () => {
    expect(adReserveVariant('gas_top', 'card', null, HOSTED)).toBe('card')
    expect(adReserveVariant('dex_after_stats', 'compact', null, HOSTED)).toBe('compact')
    expect(adReserveVariant('footer_strip', 'footer', null, HOSTED)).toBe('footer')
  })

  it('reserves a placement that is overridden but not disabled', () => {
    const ads = {
      placements: {
        gas_top: { enabled: true },
        tx_failed: { mix: [{ provider: 'binance' as const, weight: 1 }] },
      },
    }
    expect(adReserveVariant('gas_top', 'card', ads, HOSTED)).toBe('card')
    expect(adReserveVariant('tx_failed', 'compact', ads, HOSTED)).toBe('compact')
  })

  it('emits nothing for a disabled placement, and only for that placement', () => {
    const ads = { placements: { gas_top: { enabled: false } } }
    expect(adReserveVariant('gas_top', 'card', ads, HOSTED)).toBeNull()
    expect(adReserveVariant('dex_after_stats', 'compact', ads, HOSTED)).toBe('compact')
  })

  it('emits nothing for variants that are out of flow or unused in flow', () => {
    expect(adReserveVariant('address_copy', 'popover', null, HOSTED)).toBeNull()
    expect(adReserveVariant('search_results', 'inline', null, HOSTED)).toBeNull()
  })

  it('reserves nothing on a fork with no referral code and no settings', () => {
    expect(adReserveVariant('gas_top', 'card', null, FORK)).toBeNull()
    expect(adReserveVariant('dex_after_stats', 'compact', null, FORK)).toBeNull()
    expect(adReserveVariant('footer_strip', 'footer', null, FORK)).toBeNull()
  })

  it('without a referral code, reserves only placements whose mix has a house creative', () => {
    const ads = {
      creatives: [{ id: 'c1', headline: 'Our node service', ctaText: 'Learn more', ctaUrl: 'https://example.com' }],
      placements: {
        gas_top: { mix: [{ provider: 'house' as const, creativeId: 'c1', weight: 1 }] },
        tx_failed: { mix: [{ provider: 'binance' as const, weight: 1 }] },
      },
    }
    expect(adReserveVariant('gas_top', 'card', ads, FORK)).toBe('card')
    expect(adReserveVariant('tx_failed', 'compact', ads, FORK)).toBeNull()
  })

  it('a referral code saved in settings counts without the env var', () => {
    expect(adReserveVariant('gas_top', 'card', { binanceRefCode: 'MYFORK' }, FORK)).toBe('card')
  })
})
