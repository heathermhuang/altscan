'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function SearchBar() {
  const [query, setQuery] = useState('')
  const router = useRouter()

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) router.push(`/tx/${q}`)
    else if (/^0x[0-9a-fA-F]{40}$/.test(q)) router.push(`/address/${q}`)
    else if (/^\d+$/.test(q)) router.push(`/blocks/${q}`)
    else router.push(`/search?q=${encodeURIComponent(q)}`)
  }

  return (
    <form onSubmit={handleSearch} className="w-full flex gap-2">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search by address, tx hash, block number, or token name…"
        className="flex-1 px-4 py-2.5 rounded-lg text-sm bg-white border border-yellow-200 shadow-sm placeholder-gray-400 text-gray-800 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent"
        suppressHydrationWarning
      />
      <button
        type="submit"
        className="px-4 py-2.5 bg-black text-yellow-400 text-sm font-semibold rounded-lg hover:bg-gray-900 transition-colors shrink-0"
      >
        Search
      </button>
    </form>
  )
}
