'use client'

import type { BinanceReferralVariant } from '@/lib/binance-referral'
import { AdFrame } from './AdFrame'

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

  return (
    <AdFrame
      variant={variant}
      className={className}
      accent="house"
      mark={mark}
      eyebrow="Sponsored"
      title={creative.headline}
      body={creative.body}
      cta={cta}
    />
  )
}
