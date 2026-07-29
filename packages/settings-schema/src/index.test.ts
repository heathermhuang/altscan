import { describe, expect, it } from 'vitest'
import {
  AD_PLACEMENTS,
  SETTINGS_KEYS,
  isSettingsKey,
  parseSetting,
} from './index'

describe('settings-schema', () => {
  it('exposes the Phase A namespaces plus the Phase B rpc namespace', () => {
    expect(SETTINGS_KEYS.sort()).toEqual(['ads', 'footer', 'links', 'rpc'])
    expect(isSettingsKey('ads')).toBe(true)
    expect(isSettingsKey('rpc')).toBe(true)
    expect(isSettingsKey('style')).toBe(false)
  })

  describe('rpc namespace', () => {
    it('accepts an https URL and in-range timeout, and the empty override', () => {
      expect(parseSetting('rpc', { webRpcUrl: 'https://bsc-dataseed.binance.org' })).toEqual({
        webRpcUrl: 'https://bsc-dataseed.binance.org',
      })
      expect(parseSetting('rpc', { rpcTimeoutMs: 12000 })).toEqual({ rpcTimeoutMs: 12000 })
      expect(parseSetting('rpc', {})).toEqual({})
    })

    it('rejects non-https, malformed, and injection-shaped URLs', () => {
      for (const webRpcUrl of [
        'http://bsc-dataseed.binance.org', // plaintext
        'ws://bsc-dataseed.binance.org',
        'wss://bsc-dataseed.binance.org',
        '//bsc-dataseed.binance.org', // protocol-relative
        '/bsc', // relative — not valid for an RPC endpoint
        'javascript:alert(1)',
        'https://evil.test\\@good.test', // backslash
        'https://evil.test\nHost: x', // control char
        'https://exa mple.test', // space
        'not a url',
        '',
      ]) {
        expect(parseSetting('rpc', { webRpcUrl })).toBeNull()
      }
      expect(parseSetting('rpc', { webRpcUrl: `https://x.test/${'a'.repeat(2048)}` })).toBeNull()
    })

    // The blocked-host rule lives in the SCHEMA so it binds the settings PUT
    // and the provider build path too — not only the console's probe. Without
    // it, a direct PUT (or the console's "save anyway" confirm) could persist
    // an internal address that the explorer then fetches server-side.
    it('rejects hosts an RPC override must never point at', () => {
      for (const webRpcUrl of [
        'https://localhost:8545',
        'https://LOCALHOST/rpc',
        'https://api.localhost/rpc',
        'https://db.internal/rpc',
        'https://printer.local/rpc',
        'https://127.0.0.1:8545',
        'https://169.254.169.254/latest/meta-data', // cloud metadata
        'https://10.0.0.5/rpc',
        'https://172.16.0.1/rpc',
        'https://192.168.1.1/rpc',
        'https://[::1]:8545',
        'https://[fd00::1]/rpc',
        // Trailing dot = the fully-qualified form; resolves identically, so it
        // must not slip past the comparisons.
        'https://localhost./rpc',
        'https://localhost.:8545/rpc',
        'https://api.localhost./rpc',
        'https://db.internal./rpc',
        'https://printer.local./rpc',
        'https://127.0.0.1./rpc',
        'https://169.254.169.254./latest/meta-data',
        'https://10.0.0.5../rpc',
      ]) {
        expect(parseSetting('rpc', { webRpcUrl })).toBeNull()
      }
      // A normal public endpoint is unaffected.
      expect(parseSetting('rpc', { webRpcUrl: 'https://bsc-dataseed.binance.org' })).not.toBeNull()
    })

    it('bounds rpcTimeoutMs to an integer 1000..60000 and rejects unknown keys', () => {
      expect(parseSetting('rpc', { rpcTimeoutMs: 999 })).toBeNull()
      expect(parseSetting('rpc', { rpcTimeoutMs: 60001 })).toBeNull()
      expect(parseSetting('rpc', { rpcTimeoutMs: 1500.5 })).toBeNull()
      expect(parseSetting('rpc', { rpcTimeoutMs: '8000' })).toBeNull()
      expect(parseSetting('rpc', { indexerRpcUrl: 'https://x.test' })).toBeNull()
    })
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

  it('rejects backslash and control-character href tricks', () => {
    const TAB = String.fromCharCode(9)
    const NL = String.fromCharCode(10)
    const BS = String.fromCharCode(92)
    const tricky = ['/' + BS + 'evil.example', '/' + TAB + '/evil.example', '/' + NL + '/evil.example', '/ x']
    for (const href of tricky) {
      expect(parseSetting('links', { quickLinks: [{ label: 'x', href }] })).toBeNull()
    }
  })

  it('trims hrefs and still accepts normal paths', () => {
    const v = parseSetting('links', { quickLinks: [{ label: 'x', href: ' /blocks ' }] })
    expect(v?.quickLinks[0]?.href).toBe('/blocks')
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
