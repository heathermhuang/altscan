/**
 * Cloudflare's edge ranges: a request whose connecting peer is in one of these crossed
 * Cloudflare, which sets cf-connecting-ip itself and refuses a client-supplied one
 * (error 1000). From any other peer that header may be forged.
 *
 * No imports, so the Edge-runtime middleware can load it (`@altscan/explorer-core/
 * cloudflare-ranges`); clientIpFromHeaders in rate-limit.ts reads the same list.
 *
 * https://www.cloudflare.com/ips/ (fetched 2026-10-06). If Cloudflare adds a range and
 * this goes stale, requests from it fall back to the peer IP — never spoofable.
 */
export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]
