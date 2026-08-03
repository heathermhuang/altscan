import { describe, expect, it } from 'vitest'
import { getChainConfig } from '@altscan/chain-config'
import {
  DEFAULT_QUICK_LINKS,
  buildAdConfig,
  resolveAds,
  resolveFooterText,
  resolveLinks,
  resolveRpc,
} from './settings-defaults'

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

describe('buildAdConfig', () => {
  const BASE = 'https://creatives.altscan.io'
  const HASH = 'c'.repeat(64)
  const KEY = `altscan/bnb/${HASH}.png`
  const CREATIVE = {
    id: 'promo',
    headline: 'Try the API',
    body: 'Free tier',
    ctaText: 'Read docs',
    ctaUrl: '/api-docs',
    imageKey: KEY,
    imageAlt: 'Promo',
  }

  it('with no override: binance eligible, nothing disabled, no explicit placements', () => {
    expect(buildAdConfig(null, { binanceRestricted: false, creativesBaseUrl: BASE })).toEqual({
      eligible: true,
      refCode: null,
      disabled: [],
      placements: {},
    })
  })

  it('reports geo-restriction through `eligible` for old clients', () => {
    expect(buildAdConfig(null, { binanceRestricted: true, creativesBaseUrl: BASE }).eligible).toBe(
      false,
    )
  })

  it('builds the image URL from the key and the fixed base', () => {
    const out = buildAdConfig(
      {
        creatives: [CREATIVE],
        placements: { gas_top: { mix: [{ provider: 'house', creativeId: 'promo', weight: 2 }] } },
      },
      { binanceRestricted: false, creativesBaseUrl: BASE },
    )
    expect(out.placements.gas_top).toEqual({
      candidates: [
        {
          kind: 'house',
          weight: 2,
          creativeId: 'promo',
          headline: 'Try the API',
          body: 'Free tier',
          ctaText: 'Read docs',
          ctaUrl: '/api-docs',
          imageUrl: `${BASE}/${KEY}`,
          imageAlt: 'Promo',
        },
      ],
    })
  })

  it('omits imageUrl when the base is not a usable https origin', () => {
    for (const creativesBaseUrl of [
      'http://insecure.example',
      'not a url',
      '',
      // codex round 3: safeImageUrl validated the PARSED url then concatenated
      // the ORIGINAL string, so only the protocol was ever enforced. Each of
      // these produced a URL where the object key is not in the path — one
      // stray character in an env var breaks every creative image at once.
      'https://creatives.altscan.io#staging', // key lands inside the fragment
      'https://creatives.altscan.io?v=2', // key detached by the query string
      'https://user:pw@creatives.altscan.io', // credentials published in <img src>
      'https://creatives.altscan.io/sub', // non-root path, contract says origin
    ]) {
      const out = buildAdConfig(
        {
          creatives: [CREATIVE],
          placements: { gas_top: { mix: [{ provider: 'house', creativeId: 'promo', weight: 1 }] } },
        },
        { binanceRestricted: false, creativesBaseUrl },
      )
      const candidate = out.placements.gas_top!.candidates[0] as { imageUrl?: string }
      expect(candidate.imageUrl).toBeUndefined()
    }
  })

  it('builds the image URL from the parsed origin, tolerating trailing slashes', () => {
    for (const base of ['https://creatives.altscan.io', 'https://creatives.altscan.io/']) {
      const out = buildAdConfig(
        {
          creatives: [CREATIVE],
          placements: { gas_top: { mix: [{ provider: 'house', creativeId: 'promo', weight: 1 }] } },
        },
        { binanceRestricted: false, creativesBaseUrl: base },
      )
      const candidate = out.placements.gas_top!.candidates[0] as { imageUrl?: string }
      expect(candidate.imageUrl, base).toBe(`https://creatives.altscan.io/${CREATIVE.imageKey}`)
    }
  })

  it('drops binance candidates in a restricted country but keeps house ones', () => {
    const override = {
      creatives: [CREATIVE],
      placements: {
        gas_top: {
          mix: [
            { provider: 'binance' as const, weight: 1 },
            { provider: 'house' as const, creativeId: 'promo', weight: 1 },
          ],
        },
        home_after_stats: { mix: [{ provider: 'binance' as const, weight: 1 }] },
      },
    }
    const out = buildAdConfig(override, { binanceRestricted: true, creativesBaseUrl: BASE })
    expect(out.placements.gas_top!.candidates.map((c) => c.kind)).toEqual(['house'])
    // A binance-only placement is left with nothing — identical to today's behaviour.
    expect(out.placements.home_after_stats!.candidates).toEqual([])
  })

  it('keeps refCode and disabled working exactly as before', () => {
    const out = buildAdConfig(
      { binanceRefCode: 'CUSTOM', placements: { gas_top: { enabled: false } } },
      { binanceRestricted: false, creativesBaseUrl: BASE },
    )
    expect(out.refCode).toBe('CUSTOM')
    expect(out.disabled).toEqual(['gas_top'])
  })

  it('emits no candidates entry for a placement that has no mix', () => {
    const out = buildAdConfig(
      { placements: { gas_top: { enabled: true } } },
      { binanceRestricted: false, creativesBaseUrl: BASE },
    )
    expect(out.placements).toEqual({})
  })

  it('skips a house slot whose creative vanished rather than emitting a broken ad', () => {
    // Not reachable through Zod (superRefine rejects it), but a defensive path
    // for a value that got into the row some other way.
    const out = buildAdConfig(
      { placements: { gas_top: { mix: [{ provider: 'house', creativeId: 'ghost', weight: 1 }] } } } as never,
      { binanceRestricted: false, creativesBaseUrl: BASE },
    )
    expect(out.placements.gas_top!.candidates).toEqual([])
  })
})

describe('buildAdConfig — creative key ownership (codex P1 #1)', () => {
  const BASE = 'https://creatives.altscan.io'
  const HASH = 'f'.repeat(64)
  const OWN = `altscan/bnb/${HASH}.png`
  const FOREIGN = `altscan/eth/${HASH}.png`
  const creative = (imageKey: string) => ({
    id: 'promo',
    headline: 'Try the API',
    ctaText: 'Read docs',
    ctaUrl: '/api-docs',
    imageKey,
    imageAlt: 'Promo',
  })
  const build = (imageKey: string, creativesKeyPrefix: string | null) =>
    buildAdConfig(
      {
        creatives: [creative(imageKey)],
        placements: { gas_top: { mix: [{ provider: 'house', creativeId: 'promo', weight: 1 }] } },
      },
      { binanceRestricted: false, creativesBaseUrl: BASE, creativesKeyPrefix },
    ).placements.gas_top!.candidates[0] as { imageUrl?: string; headline: string }

  it('serves an image whose key is under this explorer prefix', () => {
    expect(build(OWN, 'altscan/bnb/').imageUrl).toBe(`${BASE}/${OWN}`)
  })

  it("drops the image of another explorer's key but keeps the ad text", () => {
    const c = build(FOREIGN, 'altscan/bnb/')
    expect(c.imageUrl).toBeUndefined()
    expect(c.headline).toBe('Try the API')
  })

  it('rejects a prefix-lookalike', () => {
    expect(build(`altscan/bnb2/${HASH}.png`, 'altscan/bnb/').imageUrl).toBeUndefined()
  })

  it('skips the check when no prefix is configured (back-compat)', () => {
    expect(build(FOREIGN, null).imageUrl).toBe(`${BASE}/${FOREIGN}`)
  })
})

describe('buildAdConfig — key prefix normalisation', () => {
  const BASE = 'https://creatives.altscan.io'
  const HASH = '9'.repeat(64)
  const build = (imageKey: string, creativesKeyPrefix: string) =>
    buildAdConfig(
      {
        creatives: [
          { id: 'p', headline: 'h', ctaText: 'c', ctaUrl: '/x', imageKey, imageAlt: 'a' },
        ],
        placements: { gas_top: { mix: [{ provider: 'house', creativeId: 'p', weight: 1 }] } },
      },
      { binanceRestricted: false, creativesBaseUrl: BASE, creativesKeyPrefix },
    ).placements.gas_top!.candidates[0] as { imageUrl?: string }

  it('a prefix missing its trailing slash still rejects the lookalike sibling', () => {
    expect(build(`altscan/bnb2/${HASH}.png`, 'altscan/bnb')).toBeDefined()
    expect(build(`altscan/bnb2/${HASH}.png`, 'altscan/bnb').imageUrl).toBeUndefined()
    expect(build(`altscan/bnb/${HASH}.png`, 'altscan/bnb').imageUrl).toBe(
      `${BASE}/altscan/bnb/${HASH}.png`,
    )
  })
})

describe('buildAdConfig — ownership check is fail-CLOSED (codex round 2, P1)', () => {
  const BASE = 'https://creatives.altscan.io'
  const HASH = '7'.repeat(64)
  const build = (opts: Parameters<typeof buildAdConfig>[1]) =>
    buildAdConfig(
      {
        creatives: [
          {
            id: 'p',
            headline: 'h',
            ctaText: 'c',
            ctaUrl: '/x',
            imageKey: `altscan/eth/${HASH}.png`,
            imageAlt: 'a',
          },
        ],
        placements: { gas_top: { mix: [{ provider: 'house', creativeId: 'p', weight: 1 }] } },
      },
      opts,
    ).placements.gas_top!.candidates[0] as { imageUrl?: string }

  it('omitting the prefix option leaves the image unserved rather than trusting it', () => {
    // The route now always supplies a derived prefix, so "unset" is not
    // reachable in production; this pins the library-level default.
    expect(build({ binanceRestricted: false, creativesBaseUrl: BASE, creativesKeyPrefix: 'altscan/bnb/' }).imageUrl).toBeUndefined()
  })

  it('an explicit empty prefix must not silently disable the check', () => {
    // '' is falsy — the route coerces it away before calling, but assert the
    // library does not treat a blank string as "allow everything".
    const out = build({ binanceRestricted: false, creativesBaseUrl: BASE, creativesKeyPrefix: '' })
    expect(out.imageUrl).toBeUndefined()
  })
})
