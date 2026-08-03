import type { ChainConfig } from '@altscan/chain-config'
import {
  AD_PLACEMENTS,
  type AdPlacement,
  type AdsSettings,
  type FooterSettings,
  type HouseCreative,
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

export type BinanceCandidate = { kind: 'binance'; weight: number }
export type HouseCandidate = {
  kind: 'house'
  weight: number
  creativeId: string
  headline: string
  body?: string
  ctaText: string
  ctaUrl: string
  imageUrl?: string
  imageAlt?: string
}
export type ResolvedCandidate = BinanceCandidate | HouseCandidate

export type AdConfigPayload = {
  /** Kept for pre-Phase-B clients holding a cached config shape. */
  eligible: boolean
  refCode: string | null
  disabled: AdPlacement[]
  /** Only placements with an explicit mix appear. Absent ⇒ Binance-only. */
  placements: Partial<Record<AdPlacement, { candidates: ResolvedCandidate[] }>>
}

/** The bucket base must be a plain https ORIGIN — scheme + host, nothing else.
 *  Anything else ⇒ render the creative text-only rather than emit a broken or
 *  plaintext <img>.
 *
 *  This used to validate the parsed URL and then concatenate the ORIGINAL
 *  string, so everything the parser was consulted about got discarded. Only the
 *  protocol was actually enforced; the rest of the contract in this comment was
 *  decorative. Concretely, `CREATIVES_BASE_URL=https://creatives.altscan.io#staging`
 *  produced `https://creatives.altscan.io#staging/<key>` — the object key lands
 *  inside the fragment, the browser requests `/`, and EVERY creative image on
 *  the deployment breaks at once from one stray character in an env var. A
 *  query string detaches the key the same way, and embedded credentials would
 *  be published into every rendered <img src>. Build from base.origin so the
 *  parse result is what actually ships. */
function safeImageUrl(baseUrl: string, key: string): string | undefined {
  try {
    const base = new URL(baseUrl)
    if (base.protocol !== 'https:') return undefined
    if (base.username || base.password) return undefined
    if (base.search || base.hash) return undefined
    if (base.pathname !== '/') return undefined
    return `${base.origin}/${key}`
  } catch {
    return undefined
  }
}

function toHouseCandidate(
  creative: HouseCreative,
  weight: number,
  creativesBaseUrl: string,
  keyPrefix: string | null,
): HouseCandidate {
  // The shared schema proves the key is WELL-FORMED; only this deployment knows
  // which tenant/explorer prefix is legitimately ITS OWN. Without this check the
  // console's ownership fence is the only one, and a direct ADMIN_SECRET write,
  // a migration, or a row copied between explorers would render another
  // explorer's artwork here. Drop just the image, not the whole ad.
  // Three cases, and the difference between the last two is the whole point:
  //   null/undefined → not configured at all; no check (the route always passes
  //                    a derived prefix, so this is library back-compat only).
  //   ""             → configured but BLANK. A misconfiguration, and every key
  //                    startsWith("") — so treating it as a prefix would allow
  //                    everything. Fail CLOSED: serve no image at all.
  //   "altscan/bnb"  → normalise the trailing slash, or it also matches the
  //                    "altscan/bnb2/…" lookalike this check exists to stop.
  const configured = keyPrefix?.trim()
  const prefix =
    keyPrefix == null ? null : configured ? (configured.endsWith('/') ? configured : `${configured}/`) : ''
  const ownKey =
    !creative.imageKey || prefix === null || (prefix !== '' && creative.imageKey.startsWith(prefix))
  const imageUrl =
    creative.imageKey && ownKey ? safeImageUrl(creativesBaseUrl, creative.imageKey) : undefined
  return {
    kind: 'house',
    weight,
    creativeId: creative.id,
    ...(creative.body ? { body: creative.body } : {}),
    headline: creative.headline,
    ctaText: creative.ctaText,
    ctaUrl: creative.ctaUrl,
    ...(imageUrl ? { imageUrl } : {}),
    ...(imageUrl && creative.imageAlt ? { imageAlt: creative.imageAlt } : {}),
  }
}

/**
 * The whole payload served by /api/ads/binance-eligibility.
 *
 * Geo handling (deliberate change): restriction drops BINANCE candidates only.
 * House creatives are ours, not Binance's, so suppressing them on Binance's
 * behalf would be wrong. A placement left with no candidates renders nothing —
 * which is exactly what a binance-only placement did before this feature.
 */
export function buildAdConfig(
  override: AdsSettings | null,
  opts: {
    binanceRestricted: boolean
    creativesBaseUrl: string
    /** Prefix this explorer owns, e.g. "altscan/bnb/". null ⇒ no ownership
     *  check (back-compatible when CREATIVES_KEY_PREFIX is unset). */
    creativesKeyPrefix?: string | null
  },
): AdConfigPayload {
  const { refCode, disabled } = resolveAds(override)
  const byId = new Map((override?.creatives ?? []).map((c) => [c.id, c]))
  const placements: AdConfigPayload['placements'] = {}

  for (const [placement, cfg] of Object.entries(override?.placements ?? {})) {
    if (!cfg?.mix) continue
    const candidates: ResolvedCandidate[] = []
    for (const slot of cfg.mix) {
      if (slot.provider === 'binance') {
        if (!opts.binanceRestricted) candidates.push({ kind: 'binance', weight: slot.weight })
        continue
      }
      const creative = slot.creativeId ? byId.get(slot.creativeId) : undefined
      // Defensive: Zod already rejects a dangling reference on write and on
      // read. If one ever gets through, drop the slot — never render a
      // headline-less ad.
      if (creative) {
        candidates.push(
          toHouseCandidate(
            creative,
            slot.weight,
            opts.creativesBaseUrl,
            opts.creativesKeyPrefix ?? null,
          ),
        )
      }
    }
    placements[placement as AdPlacement] = { candidates }
  }

  return { eligible: !opts.binanceRestricted, refCode, disabled, placements }
}
