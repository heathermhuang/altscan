/**
 * Rate limiter for BNBScan API routes.
 * Delegates to @altscan/explorer-core for the shared, security-hardened implementation.
 *
 * SECURITY: key on clientIpFromHeaders() — see the note in explorer-core's rate-limit.ts.
 */
import { checkRateLimit, clientIpFromHeaders } from '@altscan/explorer-core'

export { checkRateLimit, clientIpFromHeaders }

/**
 * altscan.io's MCP Worker calls this API from Cloudflare's cross-zone Worker address, which every
 * Worker on Cloudflare shares (CF-Connecting-IP 2a06:98c0:3600::103). Keyed per IP, all MCP clients
 * — and anyone else's Worker — would share one bucket. The Worker proves itself with
 * ALTSCAN_SERVICE_TOKEN and gets its own capped bucket; it rate-limits its own clients.
 * Unset, short or wrong token: the request is limited per IP like any other, never exempted.
 */
export const SERVICE_TOKEN_HEADER = 'x-altscan-service-token'
const SERVICE_MAX_PER_MINUTE = 600
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
  if (isAltscanService(headers)) return checkRateLimit('service:altscan-mcp', SERVICE_MAX_PER_MINUTE)
  return checkRateLimit(clientIpFromHeaders(headers), maxRequests)
}
