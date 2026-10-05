'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { routeForQuery } from '@/lib/search-route'

const PLACEHOLDER = 'Search by address, tx hash, block number, or token name...'
const PLACEHOLDER_SHORT = 'Address, tx, block or token'

export function SearchBar({ size = 'md' }: { size?: 'lg' | 'md' }) {
  const [query, setQuery] = useState('')
  const router = useRouter()
  const lg = size === 'lg'

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const href = routeForQuery(query)
    if (href) router.push(href)
  }

  return (
    <form onSubmit={handleSearch} role="search" className="w-full flex gap-2">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={lg ? PLACEHOLDER : PLACEHOLDER_SHORT}
        aria-label="Search by address, tx hash, block number, or token name"
        aria-keyshortcuts="/"
        className={`flex-1 min-w-0 rounded-[9px] border border-hair bg-card font-mono text-ink placeholder:text-mut hover:border-hair3 ${
          lg ? 'h-12 px-4 text-[15px]' : 'h-9 px-3 text-[13px]'
        }`}
        suppressHydrationWarning
      />
      <button
        type="submit"
        className={`shrink-0 rounded-[9px] bg-ink text-card font-semibold hover:opacity-90 transition-opacity ${
          lg ? 'h-12 px-6 text-[15px]' : 'h-9 px-4 text-[13px]'
        }`}
      >
        Search
      </button>
    </form>
  )
}
