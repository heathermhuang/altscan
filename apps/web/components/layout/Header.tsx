import Link from 'next/link'
import { SearchBar } from './SearchBar'

export function Header() {
  return (
    <header className="bg-yellow-500 text-black shadow-sm">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <div className="shrink-0">
          <Link href="/" className="font-bold text-xl tracking-tight block leading-tight">
            🔍 BNBScan
          </Link>
          <span className="text-xs text-black/60 font-medium tracking-wide hidden sm:block">
            by Measurable Data Token
          </span>
        </div>
        <SearchBar />
        <nav className="hidden md:flex gap-6 text-sm font-medium shrink-0">
          <Link href="/blocks">Blocks</Link>
          <Link href="/token">Tokens</Link>
          <Link href="/dex">DEX</Link>
          <Link href="/charts">Charts</Link>
          <Link href="/whales">Whales</Link>
          <Link href="/gas">Gas</Link>
          <Link href="/validators">Validators</Link>
          <Link href="/watchlist">⭐ Watchlist</Link>
          <Link href="/api-docs">API</Link>
          <Link href="/developer">Developer</Link>
          <Link href="/verify">Verify</Link>
        </nav>
      </div>
    </header>
  )
}
