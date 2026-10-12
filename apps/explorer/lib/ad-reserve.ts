import type { AdPlacement, AdsSettings } from '@altscan/settings-schema'
import type { BinanceReferralPlacement, BinanceReferralVariant } from './binance-referral'
import { resolveAds } from './settings-defaults'

export type ReservedVariant = 'card' | 'compact' | 'footer'

/**
 * Which reserve box a placement gets, or null for none. A placement that can
 * never fill gets no box, or it would leave a permanent hole: one the settings
 * disable, or one with nothing to show — no referral code for Binance and no
 * house creative in its mix (a fresh fork). `popover` is out of flow and
 * `inline` is not used in flow anywhere, so neither has a height to reserve.
 */
export function adReserveVariant(
  placement: BinanceReferralPlacement,
  variant: BinanceReferralVariant,
  ads: AdsSettings | null,
  env: NodeJS.ProcessEnv = process.env,
): ReservedVariant | null {
  if (variant !== 'card' && variant !== 'compact' && variant !== 'footer') return null
  const { refCode, disabled } = resolveAds(ads, env)
  if ((disabled as readonly string[]).includes(placement)) return null
  if (refCode !== null) return variant
  const mix = ads?.placements?.[placement as AdPlacement]?.mix ?? []
  return mix.some((slot) => slot.provider !== 'binance') ? variant : null
}
