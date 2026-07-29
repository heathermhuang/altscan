import { z } from 'zod'

/**
 * Runtime list of ad placements. MUST stay in sync with the
 * BinanceReferralPlacement union in apps/explorer/lib/binance-referral.ts —
 * a compile-time check there enforces it (added in a later task).
 */
export const AD_PLACEMENTS = [
  'home_after_stats',
  'gas_top',
  'address_low_balance',
  'address_zero_balance',
  'address_copy',
  'tx_failed',
  'token_research',
  'token_stablecoin',
  'dex_after_stats',
  'staking_after_stats',
  'whales_before_table',
  'watchlist_empty',
  'watchlist_active',
  'search_results',
  'search_no_results',
  'developer_after_links',
  'api_docs_intro',
  'verify_intro',
  'not_found',
  'footer_strip',
] as const
export type AdPlacement = (typeof AD_PLACEMENTS)[number]

/** Relative path ("/x") or absolute https URL. Blocks //, http:, javascript:,
 *  plus backslash and control/whitespace characters anywhere in the value —
 *  WHATWG URL parsers normalize backslashes to slashes and strip control
 *  chars, which would turn sneaky relative paths into off-origin URLs. The
 *  relative branch is additionally verified with the same parser browsers use. */
const httpsOrRelativeUrl = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (v) => {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i)
        if (c <= 32 || c === 92) return false // controls + space + backslash
      }
      if (v.startsWith('/')) {
        if (v.startsWith('//')) return false
        try {
          return new URL(v, 'https://placeholder.invalid').host === 'placeholder.invalid'
        } catch {
          return false
        }
      }
      return v.startsWith('https://')
    },
    { message: 'href must be a relative path (/x) or an https:// URL' },
  )

export const linksSettingsSchema = z
  .object({
    quickLinks: z
      .array(z.object({ label: z.string().trim().min(1).max(40), href: httpsOrRelativeUrl }).strict())
      .max(12),
  })
  .strict()
export type LinksSettings = z.infer<typeof linksSettingsSchema>

export const footerSettingsSchema = z
  .object({
    tagline: z.string().trim().min(1).max(80).optional(),
    notAffiliatedWith: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
export type FooterSettings = z.infer<typeof footerSettingsSchema>

export const adsSettingsSchema = z
  .object({
    binanceRefCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{2,32}$/, 'ref code: 2-32 chars of [A-Za-z0-9_-]')
      .optional(),
    // deliberately partial: only overridden placements appear; absent = enabled
    placements: z.record(z.enum(AD_PLACEMENTS), z.object({ enabled: z.boolean() }).strict()).optional(),
  })
  .strict()
export type AdsSettings = z.infer<typeof adsSettingsSchema>

/**
 * Hosts an operator-supplied endpoint may never point at.
 *
 * This lives in the SCHEMA, not in the console's probe, so it binds every path
 * that handles the value: the probe, the settings PUT, and the read side that
 * builds a provider from it. Hardening only the probe would leave the actual
 * fetch path (getWebProvider on the explorer, which runs inside a hosting
 * provider's network) reachable by a direct PUT or a "save anyway" confirm.
 *
 * Known residual: a PUBLIC DNS name that resolves to a private address still
 * passes — closing that needs resolution-aware egress control, which neither
 * the Workers nor the Node fetch surface exposes.
 */
export function isBlockedRpcHost(hostname: string): boolean {
  // Strip brackets (IPv6 literals) and TRAILING DOTS. `localhost.` is the
  // fully-qualified form of `localhost` and resolves identically, so leaving
  // the dot on would let `https://localhost./` walk straight through every
  // comparison below. Same for `127.0.0.1.` against the IPv4 pattern.
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    return true
  }
  // Any IPv6 literal, and any IPv4 literal. A legitimate public RPC endpoint is
  // a DNS name; an IP literal is the shape used to address infrastructure
  // directly (loopback, RFC1918, and 169.254.169.254 cloud metadata included).
  if (h.includes(':')) return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h)
}

/**
 * Object-key form for a house-creative image: <tenant>/<explorer>/<sha256>.<ext>.
 *
 * This lives in the SCHEMA, not in the upload route, so every path that handles
 * the value inherits it: the upload, the settings PUT, the read-back GET, and
 * the explorer's render path that prefixes it with the public bucket base.
 * Hardening only the upload would leave the PUT — which accepts an arbitrary
 * JSON body from a browser — free to store whatever it likes.
 *
 * The grammar is deliberately narrower than "a path": no scheme, no '//', no
 * '..', no query, no control characters, exactly three segments. A key that
 * cannot contain ':' or '//' cannot widen into an off-origin URL when the
 * explorer concatenates it onto the bucket base.
 */
const CREATIVE_KEY_RE =
  /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[0-9a-f]{64}\.(png|jpg|webp|gif)$/

export function isValidCreativeKey(k: unknown): boolean {
  return typeof k === 'string' && k.length <= 200 && CREATIVE_KEY_RE.test(k)
}

/** https-only, control/space/backslash-free, bounded, and never pointed at a
 *  blocked host — the httpsOrRelativeUrl ethos minus the relative branch.
 *  Server-side RPC calls cross the public internet, so http:// (plaintext) is
 *  rejected; ws(s):// is out of scope because ethers' JsonRpcProvider +
 *  FetchRequest is HTTP transport anyway. */
const httpsUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (v) => {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i)
        if (c <= 32 || c === 92) return false // controls + space + backslash
      }
      try {
        const u = new URL(v)
        return u.protocol === 'https:' && !isBlockedRpcHost(u.hostname)
      } catch {
        return false
      }
    },
    { message: 'webRpcUrl must be an https:// URL pointing at a public host' },
  )

export const rpcSettingsSchema = z
  .object({
    webRpcUrl: httpsUrl.optional(),
    rpcTimeoutMs: z.number().int().min(1000).max(60000).optional(),
  })
  .strict()
export type RpcSettings = z.infer<typeof rpcSettingsSchema>

export const SETTINGS_SCHEMAS = {
  links: linksSettingsSchema,
  footer: footerSettingsSchema,
  ads: adsSettingsSchema,
  rpc: rpcSettingsSchema,
} as const
export type SettingsKey = keyof typeof SETTINGS_SCHEMAS
export const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMAS) as SettingsKey[]

export type SettingsShape = { [K in SettingsKey]: z.infer<(typeof SETTINGS_SCHEMAS)[K]> }

/** Validate one namespace; returns null instead of throwing on ANY failure. */
export function parseSetting<K extends SettingsKey>(key: K, value: unknown): SettingsShape[K] | null {
  const result = SETTINGS_SCHEMAS[key].safeParse(value)
  return result.success ? (result.data as SettingsShape[K]) : null
}

export function isSettingsKey(k: string): k is SettingsKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMAS, k)
}
