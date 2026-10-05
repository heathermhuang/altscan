import { describe, expect, it } from 'vitest'
import { adReserveVariant } from './ad-reserve'

describe('adReserveVariant', () => {
  it('reserves every in-flow variant when settings are absent (defaults: all enabled)', () => {
    expect(adReserveVariant('gas_top', 'card', null)).toBe('card')
    expect(adReserveVariant('dex_after_stats', 'compact', null)).toBe('compact')
    expect(adReserveVariant('footer_strip', 'footer', null)).toBe('footer')
  })

  it('reserves a placement that is overridden but not disabled', () => {
    const ads = {
      placements: {
        gas_top: { enabled: true },
        tx_failed: { mix: [{ provider: 'binance' as const, weight: 1 }] },
      },
    }
    expect(adReserveVariant('gas_top', 'card', ads)).toBe('card')
    expect(adReserveVariant('tx_failed', 'compact', ads)).toBe('compact')
  })

  it('emits nothing for a disabled placement, and only for that placement', () => {
    const ads = { placements: { gas_top: { enabled: false } } }
    expect(adReserveVariant('gas_top', 'card', ads)).toBeNull()
    expect(adReserveVariant('dex_after_stats', 'compact', ads)).toBe('compact')
  })

  it('emits nothing for variants that are out of flow or unused in flow', () => {
    expect(adReserveVariant('address_copy', 'popover', null)).toBeNull()
    expect(adReserveVariant('search_results', 'inline', null)).toBeNull()
  })
})
