/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output — produces a minimal self-contained server (~80MB vs ~500MB).
  // Dramatically reduces base memory footprint on Render's 2GB pro plan.
  output: 'standalone',
  // Build-time SSG queries hit the same DB that the indexer is writing. BNB's
  // 36GB transactions table under heavy indexer load can exceed the default
  // 60s timeout. Raise to 180s so builds don't fail during DB contention.
  staticPageGenerationTimeout: 180,
  // Limit build workers to prevent OOM on Render Standard (2GB RAM)
  experimental: {
    workerThreads: false,
    cpus: 1,
  },
  // Treat EVERY user agent as an "HTML-limited bot": disables Next 15.2+
  // streaming metadata, so generateMetadata resolves BEFORE the response
  // shell flushes. On dynamic routes (token/address read request data) this
  // is what lets notFound() thrown in generateMetadata produce a real HTTP
  // 404 instead of a streamed-200 soft-404. Cost: TTFB on dynamic pages
  // waits for metadata — a cache()-deduped PK lookup the page needs anyway.
  htmlLimitedBots: /./,
  // Skip ESLint during build — reduces memory and time on Render
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@altscan/db', '@altscan/types', '@altscan/chain-config', '@altscan/explorer-core', '@altscan/settings-schema'],
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
          { key: 'Content-Security-Policy', value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''} https://www.googletagmanager.com https://www.google-analytics.com https://tagmanager.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.coincap.io https://api.coingecko.com https://www.google-analytics.com https://analytics.google.com https://stats.g.doubleclick.net https://*.google.com https://*.google.com.hk https://*.doubleclick.net wss:; frame-ancestors 'none'` },
        ],
      },
    ]
  },
}

export default nextConfig
