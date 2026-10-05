import type { ComponentProps } from 'react'
import { AdSlot } from './AdSlot'
import { getSetting } from '@/lib/settings'
import { adReserveVariant } from '@/lib/ad-reserve'

// Literal class names, here, so Tailwind's content scan keeps their rules (app/globals.css).
const RESERVE = {
  card: 'ad-r-card',
  compact: 'ad-r-compact',
  footer: 'ad-r-footer',
} as const

/**
 * Drop-in for <AdSlot> at every in-flow call site (same props). AdSlot renders
 * nothing until it has fetched its config in the browser, so the card it then
 * mounts pushes the content below it down. This wraps it in a box that already
 * has the card's height (globals.css, --ad-*-h), so mounting it moves nothing.
 *
 * The wrapper owns the caller's className (margins), so it collapses with its
 * neighbours exactly as the card's own margin did. It is emitted only for an
 * enabled placement, from the settings the footer already reads at ISR time:
 * no headers() or cookies, so no page goes dynamic. A viewer who ends up with no
 * ad (restricted country, placement disabled since the page was rendered) gets
 * a marker from AdSlot and the box collapses.
 */
export async function AdReserve({ className = '', ...slot }: ComponentProps<typeof AdSlot>) {
  const reserve = adReserveVariant(slot.placement, slot.variant ?? 'card', await getSetting('ads'))
  if (!reserve) return <AdSlot {...slot} className={className} />
  return (
    <div className={className ? `${RESERVE[reserve]} ${className}` : RESERVE[reserve]}>
      <AdSlot {...slot} />
    </div>
  )
}
