import { describe, expect, it } from 'vitest'
import { getChainConfig } from '@altscan/chain-config'
import { DEFAULT_QUICK_LINKS, resolveAds, resolveFooterText, resolveLinks } from './settings-defaults'

const bnb = getChainConfig('bnb')

describe('settings-defaults', () => {
  it('falls back to the built-in quick links', () => {
    expect(resolveLinks(null)).toEqual(DEFAULT_QUICK_LINKS)
    expect(resolveLinks({ quickLinks: [] })).toEqual(DEFAULT_QUICK_LINKS)
  })

  it('uses override links when present', () => {
    const links = [{ label: 'Docs', href: '/api-docs' }]
    expect(resolveLinks({ quickLinks: links })).toEqual(links)
  })

  it('falls back to chain-config footer text', () => {
    expect(resolveFooterText(null, bnb)).toEqual({
      tagline: bnb.tagline,
      notAffiliatedWith: bnb.notAffiliatedWith,
    })
    expect(resolveFooterText({ tagline: 'Custom' }, bnb).tagline).toBe('Custom')
    expect(resolveFooterText({ tagline: 'Custom' }, bnb).notAffiliatedWith).toBe(bnb.notAffiliatedWith)
  })

  it('computes disabled placements and ref code', () => {
    expect(resolveAds(null)).toEqual({ refCode: null, disabled: [] })
    const r = resolveAds({
      binanceRefCode: 'XYZ',
      placements: { footer_strip: { enabled: false }, gas_top: { enabled: true } },
    })
    expect(r.refCode).toBe('XYZ')
    expect(r.disabled).toEqual(['footer_strip'])
  })
})
