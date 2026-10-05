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
      className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-ink px-3 text-xs font-bold text-card shadow-sm transition-colors hover:bg-ink2 focus:outline-none focus:ring-2 focus:ring-mut focus:ring-offset-2 focus:ring-offset-card"
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
      className="h-9 w-9 shrink-0 rounded-lg border border-hair object-cover"
    />
  ) : null

  if (variant === 'popover') {
    return (
      <div className={`w-64 rounded-lg border border-hair bg-card p-3 text-left shadow-lg ${className}`}>
        <p className="mb-1 text-[10px] font-semibold uppercase text-mut">Sponsored</p>
        <p className="text-sm font-semibold text-ink">{creative.headline}</p>
        {creative.body && <p className="mt-1 text-xs leading-5 text-mut">{creative.body}</p>}
        <div className="mt-3">{cta}</div>
      </div>
    )
  }

  if (variant === 'inline') {
    return (
      <div
        className={`flex flex-col gap-3 rounded-lg border border-hair bg-canvas px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${className}`}
      >
        <div className="flex min-w-0 items-center gap-3">
          {mark}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase text-mut">Sponsored</p>
            <p className="font-semibold text-ink">{creative.headline}</p>
            {creative.body && <p className="text-xs text-ink2">{creative.body}</p>}
          </div>
        </div>
        {cta}
      </div>
    )
  }

  if (variant === 'footer') {
    return (
      <div className={`slot-footer border-b border-gray-800 bg-gray-950/60 ${className}`}>
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {mark}
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase text-gray-400">Sponsored</p>
              <p className="truncate font-medium text-gray-200">
                {creative.headline}
                {creative.body && <span className="ml-2 hidden text-gray-400 sm:inline">{creative.body}</span>}
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
      className={`flex flex-col justify-center overflow-hidden rounded-xl border border-hair bg-card shadow-sm ${compact ? 'slot-compact p-4' : 'slot-card p-5'} ${className}`}
    >
      <div
        className={`flex flex-col gap-4 sm:flex-row ${compact ? 'sm:items-start' : 'sm:items-center sm:justify-between'}`}
      >
        <div className="flex min-w-0 items-start gap-3">
          {mark}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-mut">Sponsored</p>
            <p className="mt-0.5 line-clamp-2 font-semibold text-ink sm:line-clamp-1">{creative.headline}</p>
            {creative.body && (
              <p className="mt-1 line-clamp-3 text-sm leading-5 text-mut sm:line-clamp-2">{creative.body}</p>
            )}
          </div>
        </div>
        <div className={compact ? 'shrink-0 sm:ml-auto' : 'shrink-0'}>{cta}</div>
      </div>
    </div>
  )
}
