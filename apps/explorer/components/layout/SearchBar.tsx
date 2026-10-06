'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { routeForQuery } from '@/lib/search-route'

const PLACEHOLDER = 'Search by address, tx hash, block number, or token name...'
const PLACEHOLDER_SHORT = 'Address, tx, block or token'

export function SearchBar({ size = 'md', label }: { size?: 'lg' | 'md'; label?: string }) {
  const [query, setQuery] = useState('')
  const router = useRouter()
  const lg = size === 'lg'

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const href = routeForQuery(query)
    if (href) router.push(href)
  }

  return (
    <form onSubmit={handleSearch} role="search" aria-label={label} className={lg ? 'sb sb-lg' : 'sb'}>
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={lg ? PLACEHOLDER : PLACEHOLDER_SHORT}
        aria-label="Search by address, tx hash, block number, or token name"
        aria-keyshortcuts="/"
        suppressHydrationWarning
      />
      <button type="submit">Search</button>
    </form>
  )
}
