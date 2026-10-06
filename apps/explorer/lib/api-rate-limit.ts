/**
 * Rate limiter for BNBScan API routes.
 * Delegates to @altscan/explorer-core for the shared, security-hardened implementation.
 *
 * SECURITY: key on clientIpFromHeaders() — see the note in explorer-core's rate-limit.ts.
 */
export { checkRateLimit, checkIpRateLimit, clientIpFromHeaders } from '@altscan/explorer-core'
