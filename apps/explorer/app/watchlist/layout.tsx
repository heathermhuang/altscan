import type { Metadata } from 'next'
import { chainConfig } from '@/lib/chain'

export const metadata: Metadata = {
  title: 'Watchlist',
  description: `Track your favorite ${chainConfig.name} addresses. Monitor wallet activity and token balances on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/watchlist' },
}

export default function WatchlistLayout({ children }: { children: React.ReactNode }) {
  return children
}
