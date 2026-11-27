'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { chainConfig } from '@/lib/chain-client'
import {
  getBinanceReferralCopy,
  getBinanceReferralUrl,
  type BinanceReferralContext,
  type BinanceReferralPlacement,
  type BinanceReferralVariant,
} from '@/lib/binance-referral'
import { pickWeighted } from '@/lib/ad-rotation'
import { HouseAd, type HouseAdCreative } from './HouseAd'
import { BinanceAd } from './BinanceAd'

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

type BinanceCandidate = { kind: 'binance'; weight: number }
type HouseCandidate = HouseAdCreative & { kind: 'house'; weight: number }
type Candidate = BinanceCandidate | HouseCandidate

type AdConfig = {
  eligible: boolean
  refCode: string | null
  disabled: string[]
  placements: Record<string, { candidates: Candidate[] } | undefined>
}

// v2: a cached v1 blob has no `placements` field and would suppress every house
// ad for up to 5 minutes after rollout. Bumping the key retires it immediately.
const AD_CONFIG_STORAGE_KEY = 'ad_config_v2'
const AD_CONFIG_TTL_MS = 5 * 60 * 1000
// No config (fetch failed, bad JSON) ⇒ no Binance ad: there is no referral code to link to.
const FALLBACK: AdConfig = { eligible: false, refCode: null, disabled: [], placements: {} }

/** A placement with no explicit mix is Binance-only — the pre-Phase-B default. */
const BINANCE_ONLY: Candidate[] = [{ kind: 'binance', weight: 1 }]

let adConfigCache: { config: AdConfig; at: number } | null = null
let adConfigPromise: Promise<AdConfig> | null = null

function normalizeConfig(data: Partial<AdConfig>): AdConfig {
  return {
    eligible: data.eligible !== false,
    refCode: typeof data.refCode === 'string' ? data.refCode : null,
    disabled: Array.isArray(data.disabled) ? data.disabled : [],
    placements: data.placements && typeof data.placements === 'object' ? data.placements : {},
  }
}

/** In-memory cache honors the same TTL as sessionStorage, so a long-lived SPA
 *  session picks up settings changes at the next ad mount after expiry
 *  instead of keeping the first-fetched config until a hard reload. */
function freshCachedConfig(): AdConfig | null {
  return adConfigCache && Date.now() - adConfigCache.at < AD_CONFIG_TTL_MS
    ? adConfigCache.config
    : null
}

async function loadAdConfig(): Promise<AdConfig> {
  const fresh = freshCachedConfig()
  if (fresh) return fresh
  if (typeof window === 'undefined') return { ...FALLBACK, eligible: false }

  try {
    const raw = window.sessionStorage.getItem(AD_CONFIG_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AdConfig> & { at?: number }
      if (typeof parsed.at === 'number' && Date.now() - parsed.at < AD_CONFIG_TTL_MS) {
        adConfigCache = { at: parsed.at, config: normalizeConfig(parsed) }
        return adConfigCache.config
      }
    }
  } catch {
    // Storage may be unavailable in strict privacy modes.
  }

  adConfigPromise ??= fetch('/api/ads/binance-eligibility', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : FALLBACK))
    .then((data: Partial<AdConfig>) => normalizeConfig(data))
    .catch(() => FALLBACK)
    .then((config) => {
      adConfigCache = { config, at: Date.now() }
      adConfigPromise = null // allow a refetch once the TTL lapses
      try {
        window.sessionStorage.setItem(
          AD_CONFIG_STORAGE_KEY,
          JSON.stringify({ ...config, at: Date.now() }),
        )
      } catch {
        // Ignore storage failures; the in-memory cache still covers this page.
      }
      return config
    })

  return adConfigPromise
}

export function AdSlot({
  context,
  placement,
  variant = 'card',
  className = '',
}: {
  context: BinanceReferralContext
  placement: BinanceReferralPlacement
  variant?: BinanceReferralVariant
  className?: string
}) {
  // Always null on the first render, like the server. Seeding from the module
  // cache mismatched on hydration: the layout's footer AdSlot hydrates first and
  // its effect fills the cache (from /api/ads or sessionStorage), so a page AdSlot
  // hydrating after it rendered a card where the server HTML had none (React
  // #418), and React client-rendered the whole page segment. The effect below
  // still applies a cached config on the very next render.
  const [config, setConfig] = useState<AdConfig | null>(null)
  // The roll is taken once per mount and held, so a re-render cannot swap the
  // ad out from under the reader mid-view.
  const [roll] = useState(() => Math.random())
  const impressionTracked = useRef(false)
  const copy = useMemo(() => getBinanceReferralCopy(context, chainConfig), [context])
  // Only read when a binance candidate is chosen, which requires a refCode (below).
  const href = config?.refCode ? getBinanceReferralUrl(config.refCode) : ''

  useEffect(() => {
    let alive = true
    loadAdConfig().then((next) => {
      if (alive) setConfig(next)
    })
    return () => {
      alive = false
    }
  }, [])

  // Settings can disable individual placements. Geo-ineligibility no longer
  // hides everything — the server already dropped binance candidates for
  // restricted countries, so a house ad still runs there. A deployment with no
  // referral code configured gets no binance candidates at all.
  const candidates = config
    ? config.disabled.includes(placement)
      ? []
      : (config.placements[placement]?.candidates ?? BINANCE_ONLY).filter(
          (c) => c.kind !== 'binance' || (config.eligible && config.refCode !== null),
        )
    : null
  const chosen = candidates ? pickWeighted(candidates, roll) : null

  useEffect(() => {
    if (!chosen || impressionTracked.current) return
    impressionTracked.current = true
    window.gtag?.('event', 'ad_impression', {
      ad_platform: chosen.kind,
      ad_placement: placement,
      ad_variant: variant,
      chain: chainConfig.key,
      ...(chosen.kind === 'house' ? { creative_id: chosen.creativeId } : {}),
    })
  }, [chosen, placement, variant])

  // Null until the config has loaded (so SSR and hydration match); after that an
  // empty placement leaves a marker, which collapses AdReserve's reserved box.
  if (!chosen) return config ? <span hidden data-ad-empty="" /> : null

  const handleClick = () => {
    window.gtag?.('event', 'ad_click', {
      ad_platform: chosen.kind,
      ad_placement: placement,
      ad_variant: variant,
      chain: chainConfig.key,
      ...(chosen.kind === 'house' ? { creative_id: chosen.creativeId } : {}),
    })
  }

  if (chosen.kind === 'house') {
    return <HouseAd creative={chosen} variant={variant} className={className} onCtaClick={handleClick} />
  }

  return <BinanceAd copy={copy} href={href} variant={variant} className={className} onCtaClick={handleClick} />
}
