// Chain config can't be imported here (TypeScript package, Next.js 14 config is pure JS).
// Use CHAIN env var directly for the few values needed at config level.
const CHAIN = process.env.CHAIN ?? 'bnb'
const DOMAIN = CHAIN === 'eth' ? 'ethscan.io' : 'bnbscan.com'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Limit build workers to prevent OOM on Render Standard (2GB RAM)
  experimental: {
    workerThreads: false,
    cpus: 1,
  },
  transpilePackages: ['@bnbscan/db', '@bnbscan/types', '@bnbscan/chain-config'],
  async headers() {
    return [
      // Security headers for all pages
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.coincap.io https://api.coingecko.com wss:; frame-ancestors 'none'" },
        ],
      },
      // CORS for API routes — restrict to known origins
      {
        source: '/api/v1/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: process.env.NEXT_PUBLIC_PEER_URL ? `https://${DOMAIN}, ${process.env.NEXT_PUBLIC_PEER_URL}` : `https://${DOMAIN}` },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, X-API-Key' },
          { key: 'Access-Control-Max-Age', value: '86400' },
        ],
      },
    ]
  },
}

export default nextConfig
