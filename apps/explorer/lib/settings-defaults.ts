import type { ChainConfig } from '@altscan/chain-config'
import {
  AD_PLACEMENTS,
  type AdPlacement,
  type AdsSettings,
  type FooterSettings,
  type LinksSettings,
} from '@altscan/settings-schema'

/** Mirrors the hardcoded footer links this feature replaces (Footer.tsx). */
export const DEFAULT_QUICK_LINKS: LinksSettings['quickLinks'] = [
  { label: 'Blocks', href: '/blocks' },
  { label: 'Transactions', href: '/txs' },
  { label: 'Tokens', href: '/token' },
  { label: 'Charts', href: '/charts' },
  { label: 'API', href: '/api-docs' },
  { label: 'Developer', href: '/developer' },
  { label: 'About', href: '/about' },
  { label: 'Status', href: 'https://status.altscan.io' },
  { label: 'GitHub', href: 'https://github.com/heathermhuang/altscan' },
]

export function resolveLinks(override: LinksSettings | null): LinksSettings['quickLinks'] {
  return override?.quickLinks?.length ? override.quickLinks : DEFAULT_QUICK_LINKS
}

export function resolveFooterText(
  override: FooterSettings | null,
  chain: ChainConfig,
): { tagline: string; notAffiliatedWith: string } {
  return {
    tagline: override?.tagline ?? chain.tagline,
    notAffiliatedWith: override?.notAffiliatedWith ?? chain.notAffiliatedWith,
  }
}

export function resolveAds(override: AdsSettings | null): {
  refCode: string | null
  disabled: AdPlacement[]
} {
  const placements = override?.placements ?? {}
  return {
    refCode: override?.binanceRefCode ?? null,
    disabled: AD_PLACEMENTS.filter((p) => placements[p]?.enabled === false),
  }
}
