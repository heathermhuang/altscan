import Link from 'next/link'
import type { ChainKey } from '@altscan/chain-config'
import { SearchBar } from '@/components/layout/SearchBar'
import { AdSlot } from '@/components/ads/AdSlot'
import { chainConfig } from '@/lib/chain'

// How far back this explorer indexes. Keyed by ChainKey so a new chain is a compile error here.
const INDEXED_WINDOW: Record<ChainKey, string> = { bnb: '2 days', eth: '4 days' }

export default function NotFound() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-20 text-center">
      <p className="text-6xl font-black text-gray-200 mb-4">404</p>
      <h1 className="text-xl font-bold mb-2">Page not found</h1>
      <p className="text-gray-500 text-sm mb-8">
        Nothing here matches that block, transaction or address. This explorer indexes about
        the last {INDEXED_WINDOW[chainConfig.key]} of {chainConfig.name} and looks older blocks and
        transactions up live, so a miss usually means a typo or a hash from another chain.
      </p>
      <div className="max-w-lg mx-auto mb-8">
        <SearchBar />
      </div>
      <AdSlot
        context="not_found"
        placement="not_found"
        variant="compact"
        className="mb-8 text-left"
      />
      <div className="flex flex-wrap justify-center gap-3 text-sm">
        <Link href="/" className="text-gray-600 hover:underline">Home</Link>
        <span className="text-gray-300">·</span>
        <Link href="/blocks" className="text-gray-600 hover:underline">Blocks</Link>
        <span className="text-gray-300">·</span>
        <Link href="/txs" className="text-gray-600 hover:underline">Transactions</Link>
        <span className="text-gray-300">·</span>
        <Link href="/token" className="text-gray-600 hover:underline">Tokens</Link>
        <span className="text-faint">·</span>
        <a
          href={chainConfig.externalExplorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink2 hover:underline"
        >
          Search on {chainConfig.externalExplorer} ↗
        </a>
      </div>
    </div>
  )
}
