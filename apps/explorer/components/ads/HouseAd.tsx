'use client'

import type { BinanceReferralVariant } from '@/lib/binance-referral'

export type HouseAdCreative = {
  creativeId: string
  headline: string
  body?: string
  ctaText: string
  ctaUrl: string
  imageUrl?: string
  imageAlt?: string
}

/**
 * A house ad. Every field is plain text rendered by React (escaped by
 * construction) — there is deliberately no dangerouslySetInnerHTML here and
 * there must never be one. The image is a plain <img>, not next/image: the
 * creative host is runtime-configurable and next/image would need it hardcoded
 * into next.config.js's remotePatterns at build time.
 */
export function HouseAd({
  creative,
  variant = 'card',
  className = '',
  onCtaClick,
}: {
  creative: HouseAdCreative
  variant?: BinanceReferralVariant
  className?: string
  onCtaClick?: () => void
}) {
  const external = creative.ctaUrl.startsWith('https://')

  const cta = (
    <a
      href={creative.ctaUrl}
      {...(external
        ? { target: '_blank', rel: 'sponsored nofollow noopener noreferrer' }
        : { rel: 'sponsored' })}
      onClick={onCtaClick}
      className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-gray-900 px-3 text-xs font-bold text-white shadow-sm transition-colors hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
    >
      {creative.ctaText}
    </a>
  )

  const mark = creative.imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={creative.imageUrl}
      alt={creative.imageAlt ?? ''}
      width={36}
      height={36}
      loading="lazy"
      decoding="async"
      className="h-9 w-9 shrink-0 rounded-lg border border-gray-200 object-cover"
    />
  ) : null

  if (variant === 'popover') {
    return (
      <div className={`w-64 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg ${className}`}>
        <p className="mb-1 text-[10px] font-semibold uppercase text-gray-400">Sponsored</p>
        <p className="text-sm font-semibold text-gray-900">{creative.headline}</p>
        {creative.body && <p className="mt-1 text-xs leading-5 text-gray-500">{creative.body}</p>}
        <div className="mt-3">{cta}</div>
      </div>
    )
  }

  if (variant === 'inline') {
    return (
      <div
        className={`flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${className}`}
      >
        <div className="flex min-w-0 items-center gap-3">
          {mark}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase text-gray-500">Sponsored</p>
            <p className="font-semibold text-gray-900">{creative.headline}</p>
            {creative.body && <p className="text-xs text-gray-600">{creative.body}</p>}
          </div>
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
            {mark}
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase text-gray-500">Sponsored</p>
              <p className="truncate font-medium text-gray-200">
                {creative.headline}
                {creative.body && <span className="ml-2 hidden text-gray-500 sm:inline">{creative.body}</span>}
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
      <div
        className={`flex gap-4 ${compact ? 'items-start' : 'flex-col sm:flex-row sm:items-center sm:justify-between'}`}
      >
        <div className="flex min-w-0 items-start gap-3">
          {mark}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Sponsored</p>
            <p className="mt-0.5 font-semibold text-gray-900">{creative.headline}</p>
            {creative.body && <p className="mt-1 text-sm leading-5 text-gray-500">{creative.body}</p>}
          </div>
        </div>
        <div className={compact ? 'ml-auto shrink-0' : 'shrink-0'}>{cta}</div>
      </div>
    </div>
  )
}
