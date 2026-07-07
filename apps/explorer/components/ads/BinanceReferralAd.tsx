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

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

type AdConfig = { eligible: boolean; refCode: string | null; disabled: string[] }

const AD_CONFIG_TTL_MS = 5 * 60 * 1000
const FALLBACK: AdConfig = { eligible: true, refCode: null, disabled: [] }

let adConfigCache: AdConfig | null = null
let adConfigPromise: Promise<AdConfig> | null = null

async function loadAdConfig(): Promise<AdConfig> {
  if (adConfigCache) return adConfigCache
  if (typeof window === 'undefined') return { ...FALLBACK, eligible: false }

  try {
    const raw = window.sessionStorage.getItem('ad_config_v1')
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AdConfig> & { at?: number }
      if (typeof parsed.at === 'number' && Date.now() - parsed.at < AD_CONFIG_TTL_MS) {
        adConfigCache = {
          eligible: parsed.eligible !== false,
          refCode: typeof parsed.refCode === 'string' ? parsed.refCode : null,
          disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
        }
        return adConfigCache
      }
    }
  } catch {
    // Storage may be unavailable in strict privacy modes.
  }

  adConfigPromise ??= fetch('/api/ads/binance-eligibility', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : FALLBACK))
    .then((data: Partial<AdConfig>) => ({
      eligible: data.eligible !== false,
      refCode: typeof data.refCode === 'string' ? data.refCode : null,
      disabled: Array.isArray(data.disabled) ? data.disabled : [],
    }))
    .catch(() => FALLBACK)
    .then((config) => {
      adConfigCache = config
      try {
        window.sessionStorage.setItem('ad_config_v1', JSON.stringify({ ...config, at: Date.now() }))
      } catch {
        // Ignore storage failures; the in-memory cache still covers this page.
      }
      return config
    })

  return adConfigPromise
}

export function BinanceReferralAd({
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
  const [config, setConfig] = useState<AdConfig | null>(adConfigCache)
  const impressionTracked = useRef(false)
  const copy = useMemo(() => getBinanceReferralCopy(context, chainConfig), [context])
  const href = getBinanceReferralUrl(chainConfig.key, config?.refCode ?? null)

  useEffect(() => {
    let alive = true
    loadAdConfig().then((next) => {
      if (alive) setConfig(next)
    })
    return () => {
      alive = false
    }
  }, [])

  // Settings can disable individual placements; geo-ineligibility hides all.
  const eligible = config ? config.eligible && !config.disabled.includes(placement) : null

  useEffect(() => {
    if (!eligible || impressionTracked.current) return
    impressionTracked.current = true
    window.gtag?.('event', 'ad_impression', {
      ad_platform: 'binance',
      ad_placement: placement,
      ad_variant: variant,
      chain: chainConfig.key,
    })
  }, [eligible, placement, variant])

  if (eligible !== true) return null

  const handleClick = () => {
    window.gtag?.('event', 'ad_click', {
      ad_platform: 'binance',
      ad_placement: placement,
      ad_variant: variant,
      chain: chainConfig.key,
    })
  }

  const cta = (
    <a
      href={href}
      target="_blank"
      rel="sponsored nofollow noopener noreferrer"
      onClick={handleClick}
      className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-[#fcd535] px-3 text-xs font-bold text-[#181a20] shadow-sm transition-colors hover:bg-[#f0b90b] focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2"
    >
      {copy.cta}
    </a>
  )

  if (variant === 'popover') {
    return (
      <div className={`w-64 rounded-lg border border-yellow-200 bg-white p-3 text-left shadow-lg ${className}`}>
        <p className="mb-1 text-[10px] font-semibold uppercase text-gray-400">{copy.eyebrow}</p>
        <p className="text-sm font-semibold text-gray-900">{copy.title}</p>
        <p className="mt-1 text-xs leading-5 text-gray-500">{copy.body}</p>
        <div className="mt-3">{cta}</div>
      </div>
    )
  }

  if (variant === 'inline') {
    return (
      <div
        className={`flex flex-col gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${className}`}
      >
        <div>
          <p className="text-[10px] font-semibold uppercase text-yellow-700">{copy.eyebrow}</p>
          <p className="font-semibold text-gray-900">{copy.title}</p>
          <p className="text-xs text-gray-600">{copy.body}</p>
        </div>
        {cta}
      </div>
    )
  }

  if (variant === 'footer') {
    return (
      <div className={`border-b border-gray-800 bg-gray-950/60 ${className}`}>
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <BinanceMark />
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase text-gray-500">{copy.eyebrow}</p>
              <p className="truncate font-medium text-gray-200">
                {copy.title}
                <span className="ml-2 hidden text-gray-500 sm:inline">{copy.body}</span>
              </p>
            </div>
          </div>
          {cta}
        </div>
      </div>
    )
  }

  const compact = variant === 'compact'

  return (
    <div
      className={`overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm ${compact ? 'p-4' : 'p-5'} ${className}`}
    >
      <div className={`flex gap-4 ${compact ? 'items-start' : 'flex-col sm:flex-row sm:items-center sm:justify-between'}`}>
        <div className="flex min-w-0 items-start gap-3">
          <BinanceMark />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{copy.eyebrow}</p>
            <p className="mt-0.5 font-semibold text-gray-900">{copy.title}</p>
            <p className="mt-1 text-sm leading-5 text-gray-500">{copy.body}</p>
          </div>
        </div>
        <div className={compact ? 'ml-auto shrink-0' : 'shrink-0'}>{cta}</div>
      </div>
    </div>
  )
}

function BinanceMark() {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-yellow-200 bg-[#fcd535]/20 text-[#181a20]">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
        <path d="M12 2.25 15.08 5.33 12 8.41 8.92 5.33 12 2.25Zm5.25 5.25 3.08 3.08-3.08 3.08-3.08-3.08 3.08-3.08Zm-10.5 0 3.08 3.08-3.08 3.08-3.08-3.08L6.75 7.5ZM12 9.25l2.75 2.75L12 14.75 9.25 12 12 9.25Zm0 6.34 3.08 3.08L12 21.75l-3.08-3.08L12 15.59Z" />
      </svg>
    </span>
  )
}
