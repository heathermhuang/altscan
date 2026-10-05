'use client'
import { useEffect, useState } from 'react'
import { chainConfig } from '@/lib/chain-client'
import { AdSlot } from '@/components/ads/AdSlot'
import { AddressLink } from '@/components/ui/AddressLink'

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
      <div className="mb-5">
        <p className="k">{'// '}watchlist</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Watchlist</h1>
      </div>
      {addresses.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-lg text-ink2">Your watchlist is empty.</p>
          <p className="mt-2 text-sm text-mut">Click the star on any address page to add it here.</p>
          <AdSlot
            context="watchlist_empty"
            placement="watchlist_empty"
            variant="compact"
            className="mx-auto mt-8 max-w-2xl text-left"
          />
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
          <AdSlot
            context="watchlist_active"
            placement="watchlist_active"
            variant="compact"
            className="mt-6"
          />
        </>
      )}
    </div>
  )
}
