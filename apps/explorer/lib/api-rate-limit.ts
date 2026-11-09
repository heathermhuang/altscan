/**
 * Rate limiter for BNBScan API routes.
 * Delegates to @altscan/explorer-core for the shared, security-hardened implementation.
 *
 * SECURITY: key on clientIpFromHeaders() — see the note in explorer-core's rate-limit.ts.
 */
import { checkRateLimit, clientIpBucket, clientIpFromHeaders, refundRateLimit } from '@altscan/explorer-core'

export { checkRateLimit, clientIpBucket, clientIpFromHeaders, refundRateLimit }

/**
 * altscan.io's MCP Worker calls this API from Cloudflare's cross-zone Worker address, which every
 * Worker on Cloudflare shares (CF-Connecting-IP 2a06:98c0:3600::103). Keyed per IP, all MCP clients
 * — and anyone else's Worker — would share one bucket. The Worker proves itself with
 * ALTSCAN_SERVICE_TOKEN and gets its own capped bucket; it rate-limits its own clients.
 * Unset, short or wrong token: the request is limited per IP like any other, never exempted.
 *
 * altscan.io's public status feed (/api/chains.json) sends the token too, and names itself in
 * SERVICE_CLIENT_HEADER so its page-view-driven traffic gets a separate bucket and cannot drain
 * the one /mcp uses. The header counts only alongside a valid token.
 */
export const SERVICE_TOKEN_HEADER = 'x-altscan-service-token'
export const SERVICE_CLIENT_HEADER = 'x-altscan-service-client'
/**
 * The MCP client behind a service-token call: an HMAC of its key, set by altscan.io's Worker (lib/ip-bucket.ts there).
 * It counts only alongside a valid token, and gives each MCP client a sub-bucket, checked before the shared one, so one
 * client cannot draw the whole 600/min every other MCP client shares.
 */
export const SERVICE_CLIENT_ID_HEADER = 'x-altscan-service-client-id'
const SERVICE_MAX_PER_MINUTE = 600
const SERVICE_CLIENT_MAX_PER_MINUTE = 120
const MIN_TOKEN_LENGTH = 32

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function isAltscanService(headers: { get(name: string): string | null }): boolean {
  const expected = process.env.ALTSCAN_SERVICE_TOKEN ?? ''
  const given = headers.get(SERVICE_TOKEN_HEADER) ?? ''
  return expected.length >= MIN_TOKEN_LENGTH && constantTimeEqual(given, expected)
}

export async function checkIpRateLimit(
  headers: { get(name: string): string | null },
  maxRequests?: number,
): Promise<boolean> {
  if (isAltscanService(headers)) {
    const feed = headers.get(SERVICE_CLIENT_HEADER) === 'status-feed'
    const id = headers.get(SERVICE_CLIENT_ID_HEADER) ?? ''
    if (!feed && /^[0-9a-f]{32}$/.test(id) && !(await checkRateLimit(`service:altscan-mcp:client:${id}`, SERVICE_CLIENT_MAX_PER_MINUTE))) {
      return false
    }
    return checkRateLimit(feed ? 'service:altscan-status-feed' : 'service:altscan-mcp', SERVICE_MAX_PER_MINUTE)
  }
  return checkRateLimit(clientIpBucket(headers), maxRequests)
}
