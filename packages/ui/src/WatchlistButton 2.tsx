'use client'
import { useState, useEffect } from 'react'

const STORAGE_KEY = 'bnbscan_watchlist'

function getWatchlist(): string[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}

export function WatchlistButton({ address }: { address: string }) {
  const [watching, setWatching] = useState(false)

  useEffect(() => {
    setWatching(getWatchlist().includes(address.toLowerCase()))
  }, [address])

  const toggle = () => {
    const list = getWatchlist()
    const addr = address.toLowerCase()
    const next = list.includes(addr) ? list.filter(a => a !== addr) : [...list, addr]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setWatching(next.includes(addr))
  }

  return (
    <button
      onClick={toggle}
      title={watching ? 'Remove from watchlist' : 'Add to watchlist'}
      className="text-lg transition-transform hover:scale-110"
    >
      {watching ? '⭐' : '☆'}
    </button>
  )
}
