import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@bnbscan/db', '@bnbscan/types'],
}

export default nextConfig
