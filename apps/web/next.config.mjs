/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@bnbscan/db', '@bnbscan/types'],
  async headers() {
    return [
      {
        source: '/api/v1/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, X-API-Key' },
        ],
      },
    ]
  },
}

export default nextConfig
