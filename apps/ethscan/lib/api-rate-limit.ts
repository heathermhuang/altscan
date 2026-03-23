/**
 * Rate limiter for EthScan API routes.
 * Delegates to @bnbscan/explorer-core for the shared, security-hardened implementation.
 *
 * SECURITY: The shared implementation takes the LAST IP from X-Forwarded-For.
 * Render's LB appends the real client IP last — the first entries are attacker-controlled.
 */
export { checkRateLimit, checkIpRateLimit, extractClientIp } from '@bnbscan/explorer-core'
