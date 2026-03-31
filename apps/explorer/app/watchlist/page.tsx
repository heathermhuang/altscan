'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

const STORAGE_KEY = 'bnbscan_watchlist'

export default function WatchlistPage() {
  const [addresses, setAddresses] = useState<string[]>([])

  useEffect(() => {
    try {
      const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]
      setAddresses(list)
    } catch { setAddresses([]) }
  }, [])

  const remove = (addr: string) => {
    const next = addresses.filter(a => a !== addr)
    setAddresses(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Watchlist</h1>
      {addresses.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">Your watchlist is empty.</p>
          <p className="text-sm mt-2">Click the star on any address page to add it here.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-gray-500">Address</th>
                <th className="text-left px-4 py-2 text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {addresses.map(addr => (
                <tr key={addr} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link href={`/address/${addr}`} className="text-blue-600 hover:underline">
                      {addr}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => remove(addr)}
                      className="text-xs text-red-500 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
