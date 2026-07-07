import { describe, expect, it } from 'vitest'
import {
  AD_PLACEMENTS,
  SETTINGS_KEYS,
  isSettingsKey,
  parseSetting,
} from './index'

describe('settings-schema', () => {
  it('exposes the three Phase A namespaces', () => {
    expect(SETTINGS_KEYS.sort()).toEqual(['ads', 'footer', 'links'])
    expect(isSettingsKey('ads')).toBe(true)
    expect(isSettingsKey('rpc')).toBe(false)
  })

  it('has 20 ad placements including footer_strip', () => {
    expect(AD_PLACEMENTS).toHaveLength(20)
    expect(AD_PLACEMENTS).toContain('footer_strip')
    expect(AD_PLACEMENTS).toContain('home_after_stats')
  })

  it('accepts valid quick links', () => {
    const v = parseSetting('links', {
      quickLinks: [
        { label: 'Blocks', href: '/blocks' },
        { label: 'Status', href: 'https://status.altscan.io' },
      ],
    })
    expect(v?.quickLinks).toHaveLength(2)
  })

  it('rejects javascript:, protocol-relative, and http URLs', () => {
    for (const href of ['javascript:alert(1)', '//evil.example', 'http://x.example', 'ftp://x']) {
      expect(parseSetting('links', { quickLinks: [{ label: 'x', href }] })).toBeNull()
    }
  })

  it('rejects oversized labels and >12 links', () => {
    expect(parseSetting('links', { quickLinks: [{ label: 'x'.repeat(41), href: '/a' }] })).toBeNull()
    const links = Array.from({ length: 13 }, (_, i) => ({ label: `l${i}`, href: `/p${i}` }))
    expect(parseSetting('links', { quickLinks: links })).toBeNull()
  })

  it('rejects unknown fields (strict objects)', () => {
    expect(parseSetting('footer', { tagline: 'ok', hax: 1 })).toBeNull()
  })

  it('validates ads placements and ref code shape', () => {
    expect(
      parseSetting('ads', {
        binanceRefCode: 'BNBSCAN2',
        placements: { footer_strip: { enabled: false } },
      }),
    ).not.toBeNull()
    expect(parseSetting('ads', { placements: { not_a_placement: { enabled: false } } })).toBeNull()
    expect(parseSetting('ads', { binanceRefCode: 'has spaces!' })).toBeNull()
  })

  it('returns null (never throws) on garbage', () => {
    expect(parseSetting('links', 42)).toBeNull()
    expect(parseSetting('ads', null)).toBeNull()
  })
})
