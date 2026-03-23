'use client'
import { useState, useEffect } from 'react'

export function WatchlistButton({ address }: { address: string }) {
  const [watching, setWatching] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('ethscan_watchlist') ?? '[]'
    const list: string[] = JSON.parse(stored)
    setWatching(list.includes(address.toLowerCase()))
  }, [address])

  const toggle = () => {
    const stored = localStorage.getItem('ethscan_watchlist') ?? '[]'
    let list: string[] = JSON.parse(stored)
    const addr = address.toLowerCase()
    if (watching) {
      list = list.filter(a => a !== addr)
    } else {
      list.push(addr)
    }
    localStorage.setItem('ethscan_watchlist', JSON.stringify(list))
    setWatching(!watching)
  }

  return (
    <button
      onClick={toggle}
      className={`text-sm px-3 py-1 rounded-lg border transition-colors ${
        watching
          ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
          : 'bg-white border-gray-200 text-gray-500 hover:border-indigo-300 hover:text-indigo-600'
      }`}
      title={watching ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      {watching ? '⭐ Watching' : '☆ Watch'}
    </button>
  )
}
