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
      // The absolute branch used to be a bare startsWith('https://'), which
      // admitted `https://`, `https://%` and `https://[` — all of which save
      // cleanly and then render a house ad whose CTA goes nowhere. Parse it
      // with the same URL parser the browser will use, and require a host:
      // the prefix check proves the scheme, not that a destination exists.
      try {
        const u = new URL(v)
        return u.protocol === 'https:' && u.hostname.length > 0
      } catch {
        return false
      }
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

const creativeId = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,31}$/,
    'creative id: 1-32 chars of [a-z0-9_-], not starting with - or _',
  )

/** A house ad: structured text fields rendered by our own components. No raw
 *  HTML anywhere — ctaUrl reuses the same refinement as the footer quick-links,
 *  so javascript:, protocol-relative and control-character URLs are impossible. */
export const houseCreativeSchema = z
  .object({
    id: creativeId,
    headline: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(160).optional(),
    ctaText: z.string().trim().min(1).max(32),
    ctaUrl: httpsOrRelativeUrl,
    imageKey: z.string().trim().refine(isValidCreativeKey, {
      message: 'imageKey must be <tenant>/<explorer>/<sha256>.<png|jpg|webp|gif>',
    }).optional(),
    imageAlt: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((c) => !c.imageKey || !!c.imageAlt, {
    message: 'imageAlt is required when imageKey is set',
  })
export type HouseCreative = z.infer<typeof houseCreativeSchema>

export const adSlotSchema = z
  .object({
    provider: z.enum(['binance', 'house']),
    creativeId: creativeId.optional(),
    weight: z.number().int().min(1).max(100),
  })
  .strict()
export type AdSlotConfig = z.infer<typeof adSlotSchema>

export const adsSettingsSchema = z
  .object({
    binanceRefCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{2,32}$/, 'ref code: 2-32 chars of [A-Za-z0-9_-]')
      .optional(),
    creatives: z.array(houseCreativeSchema).max(12).optional(),
    // deliberately partial: only overridden placements appear; absent = enabled,
    // and an absent `mix` = Binance-only, i.e. the pre-Phase-B behaviour.
    placements: z
      .record(
        z.enum(AD_PLACEMENTS),
        z
          .object({
            enabled: z.boolean().optional(),
            mix: z.array(adSlotSchema).min(1).max(6).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  // Cross-field integrity belongs HERE rather than in the console, so a
  // hand-crafted PUT, a restored audit version and the explorer's read-side
  // re-validation are all bound by it. A dangling reference fails the whole
  // namespace → getSetting returns null → defaults → Binance-only. Never a
  // half-rendered ad.
  .superRefine((v, ctx) => {
    const ids = new Set<string>()
    for (const c of v.creatives ?? []) {
      if (ids.has(c.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate creative id: ${c.id}` })
      }
      ids.add(c.id)
    }
    for (const [placement, cfg] of Object.entries(v.placements ?? {})) {
      for (const slot of cfg?.mix ?? []) {
        if (slot.provider === 'house' && !ids.has(slot.creativeId ?? '')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${placement}: mix references unknown creativeId ${slot.creativeId ?? '(missing)'}`,
          })
        }
        if (slot.provider === 'binance' && slot.creativeId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${placement}: a binance slot must not carry a creativeId`,
          })
        }
      }
    }
  })
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
