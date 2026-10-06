'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { chainConfig } from '@/lib/chain-client'
import { AddressLink } from '@/components/ui/AddressLink'

const STORAGE_KEY = 'bnbscan_watchlist'

export function WatchlistView({ emptyAd, activeAd }: { emptyAd: ReactNode; activeAd: ReactNode }) {
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
    <>
      {addresses.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-lg text-ink2">Your watchlist is empty.</p>
          <p className="mt-2 text-sm text-mut">Click the star on any address page to add it here.</p>
          {emptyAd}
        </div>
      ) : (
        <>
          <div className="bg-card rounded-xl border border-hair overflow-hidden">
            <div className="overflow-x-auto">
            <table className="dt">
              <caption className="sr-only">Your watchlisted {chainConfig.name} addresses</caption>
              <thead>
                <tr>
                  <th scope="col">Address</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {addresses.map(addr => (
                  <tr key={addr}>
                    <td>
                      {/* Full address from sm up; the short form below it so Remove stays on screen on phones. */}
                      <span className="sm:hidden"><AddressLink address={addr} /></span>
                      <span className="hidden sm:inline"><AddressLink address={addr} short={false} /></span>
                    </td>
                    <td>
                      <button
                        onClick={() => remove(addr)}
                        className="text-xs text-warn hover:underline"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          {activeAd}
        </>
      )}
    </>
  )
}
