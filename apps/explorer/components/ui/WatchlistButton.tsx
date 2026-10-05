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
      className={`inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-hair bg-card text-lg leading-none transition-colors hover:border-hair3 ${watching ? 'text-acc-ink' : 'text-mut hover:text-ink'}`}
    >
      {watching ? '★' : '☆'}
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
