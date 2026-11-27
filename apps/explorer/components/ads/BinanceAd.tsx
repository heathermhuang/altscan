'use client'

import type { BinanceReferralVariant } from '@/lib/binance-referral'
import { AdFrame } from './AdFrame'

/** The Binance referral creative, in each slot variant. Which ad runs, and its tracking, is AdSlot's. */
export function BinanceAd({
  copy,
  href,
  variant,
  className,
  onCtaClick,
}: {
  copy: { eyebrow: string; title: string; body: string; cta: string }
  href: string
  variant: BinanceReferralVariant
  className: string
  onCtaClick: () => void
}) {
  const cta = (
    <a
      href={href}
      target="_blank"
      rel="sponsored nofollow noopener noreferrer"
      onClick={onCtaClick}
      className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-[#fcd535] px-3 text-xs font-bold text-[#181a20] shadow-sm transition-colors hover:bg-[#f0b90b] focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2 focus:ring-offset-card"
    >
      {copy.cta}
    </a>
  )

  return (
    <AdFrame
      variant={variant}
      className={className}
      accent="binance"
      mark={<BinanceMark />}
      footerMark={<BinanceMark glyph="text-[#fcd535]" />}
      eyebrow={copy.eyebrow}
      title={copy.title}
      body={copy.body}
      cta={cta}
    />
  )
}

// `glyph` is the glyph colour. The footer strip is a dark surface in both schemes, so it passes the
// brand yellow; the cards sit on --card and keep text-ink.
function BinanceMark({ glyph = 'text-ink' }: { glyph?: string }) {
  return (
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-yellow-200 bg-[#fcd535]/20 ${glyph}`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
        <path d="M12 2.25 15.08 5.33 12 8.41 8.92 5.33 12 2.25Zm5.25 5.25 3.08 3.08-3.08 3.08-3.08-3.08 3.08-3.08Zm-10.5 0 3.08 3.08-3.08 3.08-3.08-3.08L6.75 7.5ZM12 9.25l2.75 2.75L12 14.75 9.25 12 12 9.25Zm0 6.34 3.08 3.08L12 21.75l-3.08-3.08L12 15.59Z" />
      </svg>
    </span>
  )
}
