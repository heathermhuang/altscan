import type { ChainConfig } from '@altscan/chain-config'
import {
  AD_PLACEMENTS,
  type AdPlacement,
  type AdsSettings,
  type FooterSettings,
  type LinksSettings,
  type RpcSettings,
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

/**
 * Precedence: console override → env → chain default. Keeping env as the middle
 * tier means behaviour is byte-identical to the pre-override build whenever no
 * override row exists. The override reaches here only after Zod validation
 * (write-side AND read-side), so a malformed URL can never build a provider.
 */
export function resolveRpc(
  override: RpcSettings | null,
  chain: ChainConfig,
  env: NodeJS.ProcessEnv,
): { url: string; timeoutMs: number } {
  const envTimeout = parseInt(env.RPC_TIMEOUT_MS ?? '8000', 10)
  return {
    url: override?.webRpcUrl ?? env[chain.rpcEnvVar] ?? chain.defaultRpcUrl,
    timeoutMs: override?.rpcTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 8000),
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
