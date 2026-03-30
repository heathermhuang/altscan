'use client'
import { useState, useEffect } from 'react'

const STORAGE_KEY = 'bnbscan_watchlist'

function getWatchlist(): string[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]
  } catch { return [] }
}

function setWatchlist(list: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

export function WatchlistButton({ address }: { address: string }) {
  const [watching, setWatching] = useState(false)

  useEffect(() => {
    setWatching(getWatchlist().includes(address.toLowerCase()))
  }, [address])

  const toggle = () => {
    const list = getWatchlist()
    const addr = address.toLowerCase()
    const next = watching ? list.filter(a => a !== addr) : [...list, addr]
    setWatchlist(next)
    setWatching(!watching)
  }

  return (
    <button
      onClick={toggle}
      title={watching ? 'Remove from watchlist' : 'Add to watchlist'}
      className={`text-lg transition-colors ${watching ? 'text-yellow-500' : 'text-gray-300 hover:text-yellow-400'}`}
    >
      {watching ? '⭐' : '☆'}
    </button>
  )
}

export function useWatchlist() {
  const [list, setList] = useState<string[]>([])
  useEffect(() => {
    setList(getWatchlist())
    const handler = () => setList(getWatchlist())
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])
  return list
}
