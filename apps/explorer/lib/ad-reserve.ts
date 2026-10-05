import type { AdsSettings } from '@altscan/settings-schema'
import type { BinanceReferralPlacement, BinanceReferralVariant } from './binance-referral'
import { resolveAds } from './settings-defaults'

export type ReservedVariant = 'card' | 'compact' | 'footer'

/**
 * Which reserve box a placement gets, or null for none. A placement the
 * settings disable never fills, so reserving space for it would leave a
 * permanent hole. `popover` is out of flow and `inline` is not used in flow
 * anywhere, so neither has a height to reserve.
 */
export function adReserveVariant(
  placement: BinanceReferralPlacement,
  variant: BinanceReferralVariant,
  ads: AdsSettings | null,
): ReservedVariant | null {
  if (variant !== 'card' && variant !== 'compact' && variant !== 'footer') return null
  return (resolveAds(ads).disabled as readonly string[]).includes(placement) ? null : variant
}
