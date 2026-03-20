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
    <form onSubmit={handleSearch} className="flex-1 max-w-xl">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search by address / tx hash / block number"
        className="w-full px-4 py-2 rounded-lg text-sm border border-yellow-600 bg-yellow-400 placeholder-yellow-800 focus:outline-none focus:ring-2 focus:ring-yellow-700"
      />
    </form>
  )
}
