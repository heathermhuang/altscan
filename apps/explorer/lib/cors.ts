import { chainConfig } from '@/lib/chain'

/**
 * CORS for the public API.
 *
 * The previous policy lived as a static header in next.config.mjs and joined
 * two origins with a comma. Access-Control-Allow-Origin takes exactly one
 * origin or `*` — a list fails the check in every browser, so every
 * cross-origin call to /api/v1/* was blocked on both domains, including the
 * sister-site case the header was written to allow. Echoing one origin per
 * request needs the request, so this runs in middleware, not next.config.
 */
export function allowedOrigins(): string[] {
  const own = `https://${chainConfig.domain}`
  const peer = process.env.NEXT_PUBLIC_PEER_URL?.trim()
  return peer ? [own, peer] : [own]
}

/** Exact match only. Returns null when the origin is absent or not allowed. */
export function resolveAllowOrigin(origin: string | null, allowed: readonly string[]): string | null {
  if (!origin) return null
  return allowed.includes(origin) ? origin : null
}

export function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Max-Age': '86400',
    // Always set, even on a miss: the response varies by origin, so a shared
    // cache must not reuse one site's response for the other.
    'Vary': 'Origin',
  }
  const allow = resolveAllowOrigin(origin, allowed)
  if (allow) headers['Access-Control-Allow-Origin'] = allow
  return headers
}
