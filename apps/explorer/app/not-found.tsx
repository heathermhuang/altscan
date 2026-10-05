import Link from 'next/link'
import { SearchBar } from '@/components/layout/SearchBar'
import { AdSlot } from '@/components/ads/AdSlot'
import { chainConfig } from '@/lib/chain'

export default function NotFound() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-20 text-center">
      <p className="mb-4 font-mono text-6xl font-bold text-mut">404</p>
      <h1 className="mb-2 text-xl font-bold tracking-[-0.02em] text-ink">Page not found</h1>
      <p className="mb-8 text-sm text-ink2">
        Nothing here matches that block, transaction or address. This explorer keeps only recent{' '}
        {chainConfig.name} history in its index and looks older blocks and transactions up live, so a
        miss usually means a typo or a hash from another chain.
      </p>
      <div className="max-w-lg mx-auto mb-8">
        <SearchBar label="Search this explorer for a block, transaction or address" />
      </div>
      <AdSlot
        context="not_found"
        placement="not_found"
        variant="compact"
        className="mb-8 text-left"
      />
      <div className="flex flex-wrap justify-center gap-3 text-sm">
        <Link href="/" className="text-acc-ink hover:underline">Home</Link>
        <span className="text-faint">·</span>
        <Link href="/blocks" className="text-acc-ink hover:underline">Blocks</Link>
        <span className="text-faint">·</span>
        <Link href="/txs" className="text-acc-ink hover:underline">Transactions</Link>
        <span className="text-faint">·</span>
        <Link href="/token" className="text-acc-ink hover:underline">Tokens</Link>
        <span className="text-faint">·</span>
        <a
          href={chainConfig.externalExplorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-acc-ink hover:underline"
        >
          Look it up on {chainConfig.externalExplorer} <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>
  )
}
