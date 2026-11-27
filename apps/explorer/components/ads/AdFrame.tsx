import type { ReactNode } from 'react'
import type { BinanceReferralVariant } from '@/lib/binance-referral'

/**
 * The layout of an ad slot in each variant. Creatives (BinanceAd, HouseAd) supply the content;
 * the frame owns the boxes, so a layout change is made once for every advertiser.
 *
 * `accent` holds the two places the Binance creative deliberately differs: its brand-yellow
 * popover border and inline surface, and an inline strip with no mark.
 *
 * Text is rendered by React (escaped by construction). There is no dangerouslySetInnerHTML
 * here and there must never be one: house creatives are operator-supplied text.
 */
export function AdFrame({
  variant,
  className,
  accent,
  mark,
  footerMark = mark,
  eyebrow,
  title,
  body,
  cta,
}: {
  variant: BinanceReferralVariant
  className: string
  accent: 'binance' | 'house'
  /** Shown beside the text in the card, compact, footer and (house) inline variants. */
  mark: ReactNode
  /** The footer strip is a dark surface in both schemes, so a mark may need its own colour there. */
  footerMark?: ReactNode
  eyebrow: string
  title: string
  body?: string
  cta: ReactNode
}) {
  if (variant === 'popover') {
    const border = accent === 'binance' ? 'border-yellow-200' : 'border-pop-line'
    return (
      <div className={`w-64 rounded-lg border ${border} bg-card p-3 text-left shadow-lg ${className}`}>
        <p className="mb-1 text-[10px] font-semibold uppercase text-mut">{eyebrow}</p>
        <p className="text-sm font-semibold text-ink">{title}</p>
        {body && <p className="mt-1 text-xs leading-5 text-mut">{body}</p>}
        <div className="mt-3">{cta}</div>
      </div>
    )
  }

  if (variant === 'inline') {
    const surface = accent === 'binance' ? 'border-yellow-200 bg-[#fcd535]/10' : 'border-hair bg-canvas'
    const text = (
      <>
        <p className="text-[10px] font-semibold uppercase text-mut">{eyebrow}</p>
        <p className="font-semibold text-ink">{title}</p>
        {body && <p className="text-xs text-ink2">{body}</p>}
      </>
    )
    return (
      <div
        className={`flex flex-col gap-3 rounded-lg border ${surface} px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${className}`}
      >
        {accent === 'binance' ? (
          <div>{text}</div>
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            {mark}
            <div className="min-w-0">{text}</div>
          </div>
        )}
        {cta}
      </div>
    )
  }

  if (variant === 'footer') {
    return (
      <div className={`slot-footer border-b border-gray-800 bg-gray-950/60 ${className}`}>
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {footerMark}
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase text-gray-400">{eyebrow}</p>
              <p className="truncate font-medium text-gray-200">
                {title}
                {body && <span className="ml-2 hidden text-gray-400 sm:inline">{body}</span>}
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
      <div className={`flex flex-col gap-4 sm:flex-row ${compact ? 'sm:items-start' : 'sm:items-center sm:justify-between'}`}>
        <div className="flex min-w-0 items-start gap-3">
          {mark}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-mut">{eyebrow}</p>
            <p className="mt-0.5 line-clamp-2 font-semibold text-ink sm:line-clamp-1">{title}</p>
            {body && <p className="mt-1 line-clamp-3 text-sm leading-5 text-mut sm:line-clamp-2">{body}</p>}
          </div>
        </div>
        <div className={compact ? 'shrink-0 sm:ml-auto' : 'shrink-0'}>{cta}</div>
      </div>
    </div>
  )
}
