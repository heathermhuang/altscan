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

export const SETTINGS_SCHEMAS = {
  links: linksSettingsSchema,
  footer: footerSettingsSchema,
  ads: adsSettingsSchema,
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
