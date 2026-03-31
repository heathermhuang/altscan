import Link from 'next/link'
import { SearchBar } from '@/components/layout/SearchBar'

export default function NotFound() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-20 text-center">
      <p className="text-6xl font-black text-gray-200 mb-4">404</p>
      <h1 className="text-xl font-bold mb-2">Page not found</h1>
      <p className="text-gray-500 text-sm mb-8">
        That address, block, or transaction hash doesn&apos;t exist on this explorer.
        Try searching below.
      </p>
      <div className="max-w-lg mx-auto mb-8">
        <SearchBar />
      </div>
      <div className="flex flex-wrap justify-center gap-3 text-sm">
        <Link href="/" className="text-gray-600 hover:underline">Home</Link>
        <span className="text-gray-300">·</span>
        <Link href="/blocks" className="text-gray-600 hover:underline">Blocks</Link>
        <span className="text-gray-300">·</span>
        <Link href="/txs" className="text-gray-600 hover:underline">Transactions</Link>
        <span className="text-gray-300">·</span>
        <Link href="/token" className="text-gray-600 hover:underline">Tokens</Link>
      </div>
    </div>
  )
}
