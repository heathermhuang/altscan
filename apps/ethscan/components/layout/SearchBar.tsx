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
        className="flex-1 px-4 py-2 rounded-lg text-sm bg-white border border-indigo-200 shadow-sm placeholder-gray-400 text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
        suppressHydrationWarning
      />
      <button
        type="submit"
        className="px-4 py-2 bg-white text-indigo-700 text-sm font-semibold rounded-lg hover:bg-indigo-50 border border-white/30 transition-colors shrink-0"
      >
        Search
      </button>
    </form>
  )
}
