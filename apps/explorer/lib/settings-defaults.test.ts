import { describe, expect, it } from 'vitest'
import { getChainConfig } from '@altscan/chain-config'
import { DEFAULT_QUICK_LINKS, resolveAds, resolveFooterText, resolveLinks, resolveRpc } from './settings-defaults'

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

  describe('resolveRpc', () => {
    const envWith = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv

    it('falls back to env then chain default when there is no override', () => {
      expect(resolveRpc(null, bnb, envWith({ [bnb.rpcEnvVar]: 'https://env.test' }))).toEqual({
        url: 'https://env.test',
        timeoutMs: 8000,
      })
      expect(resolveRpc(null, bnb, envWith({}))).toEqual({
        url: bnb.defaultRpcUrl,
        timeoutMs: 8000,
      })
    })

    it('lets the override win over env for both url and timeout', () => {
      const env = envWith({ [bnb.rpcEnvVar]: 'https://env.test', RPC_TIMEOUT_MS: '5000' })
      expect(resolveRpc({ webRpcUrl: 'https://override.test', rpcTimeoutMs: 12000 }, bnb, env)).toEqual({
        url: 'https://override.test',
        timeoutMs: 12000,
      })
    })

    it('resolves each field independently — a url-only override keeps the env timeout', () => {
      const env = envWith({ [bnb.rpcEnvVar]: 'https://env.test', RPC_TIMEOUT_MS: '5000' })
      expect(resolveRpc({ webRpcUrl: 'https://override.test' }, bnb, env)).toEqual({
        url: 'https://override.test',
        timeoutMs: 5000,
      })
      expect(resolveRpc({ rpcTimeoutMs: 3000 }, bnb, env)).toEqual({
        url: 'https://env.test',
        timeoutMs: 3000,
      })
      expect(resolveRpc({}, bnb, env)).toEqual({ url: 'https://env.test', timeoutMs: 5000 })
    })

    it('ignores an unparseable or non-positive RPC_TIMEOUT_MS (matches the pre-override build)', () => {
      for (const RPC_TIMEOUT_MS of ['abc', '', '0', '-1']) {
        expect(resolveRpc(null, bnb, envWith({ RPC_TIMEOUT_MS })).timeoutMs).toBe(8000)
      }
    })
  })
})
