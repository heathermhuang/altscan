'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain-client'
import { formatNumber } from '@/lib/format'
import type { HoldersResult } from '@/lib/holders'

/**
 * Client-side holders enhancement. SSR renders the labeled local net-flow estimate (0 Moralis
 * CU, safe for crawlers / no-JS scrapers hitting the origin direct); on mount the browser fetches
 * accurate Moralis holders via /api/internal/token/<addr>/holders and swaps them in. Bots never
 * run this effect, so they never spend Moralis CU — the same model as the address tabs.
 *
 * The table and the stat-card count share ONE in-flight fetch per address (the dedupe map below),
 * so a single render makes a single XHR. (Server-side the Moralis calls are KV-cached 2h, so it's
 * also CU-safe across visitors — the client dedupe just avoids a redundant round-trip.)
 */
const inflight = new Map<string, Promise<HoldersResult | null>>()
function loadHolders(address: string): Promise<HoldersResult | null> {
  let p = inflight.get(address)
  if (!p) {
    p = fetch(`/api/internal/token/${address}/holders`)
      .then((r) => (r.ok ? (r.json() as Promise<HoldersResult>) : null))
      .catch(() => null)
    inflight.set(address, p)
  }
  return p
}

/**
 * The Holders stat-card number. Shows the indexed/local fallback until the live Moralis count
 * arrives, then the accurate total — keeping it consistent with the "N total via Moralis" header.
 */
export function HoldersCountLazy({ address, fallback }: { address: string; fallback: number }) {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    loadHolders(address).then((d) => {
      if (alive && d && d.source === 'moralis' && d.holderCount != null) setCount(d.holderCount)
    })
    return () => {
      alive = false
    }
  }, [address])
  return <>{formatNumber(count ?? fallback)}</>
}

export function HoldersLazy({
  address,
  symbol,
  decimals,
  totalSupply,
  initial,
}: {
  address: string
  symbol: string
  decimals: number
  totalSupply: string | null
  initial: HoldersResult
}) {
  const [data, setData] = useState<HoldersResult>(initial)
  useEffect(() => {
    let alive = true
    loadHolders(address).then((d) => {
      if (alive && d && d.holders.length > 0) setData(d)
    })
    return () => {
      alive = false
    }
  }, [address])

  // Nothing to show yet (empty local estimate + Moralis not loaded / also empty).
  if (data.holders.length === 0) return null

  const totalSupplyBig = (() => {
    try {
      return BigInt(totalSupply ?? '0')
    } catch {
      return 0n
    }
  })()

  return (
    <div className="bg-white rounded-xl border shadow-sm mb-6 overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
        <h2 className="font-semibold">
          Top Holders
          {data.source === 'moralis' && data.holderCount != null && (
            <span className="text-gray-400 font-normal text-sm">
              {' '}({formatNumber(data.holderCount)} total)
            </span>
          )}
        </h2>
        <span className="text-[11px] text-gray-400">
          {data.source === 'moralis' ? 'via Moralis' : 'Estimated from recent transfers'}
        </span>
      </div>
      {data.source === 'local' && (
        <div className="px-4 py-2 bg-yellow-50 text-yellow-800 text-xs border-b">
          ⚠️ Estimated from recent transfer net-flow (last ~24h), not full on-chain balances — large steady holders (e.g. exchanges) may be missing.
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-2 text-gray-500 w-10">#</th>
            <th className="text-left px-4 py-2 text-gray-500">Address</th>
            <th className="text-left px-4 py-2 text-gray-500">
              {data.source === 'moralis' ? 'Balance' : 'Approx. Balance'}
            </th>
            <th className="text-left px-4 py-2 text-gray-500">% of Supply</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.holders.map((holder, i) => {
            const holderAmount = (() => {
              try {
                const divisor = 10n ** BigInt(decimals)
                const whole = BigInt(holder.balance) / divisor
                return whole.toLocaleString()
              } catch {
                return holder.balance.slice(0, 12)
              }
            })()
            const pct = (() => {
              try {
                if (totalSupplyBig === 0n) return '—'
                const bal = BigInt(holder.balance)
                // Integer math, scaled by 10000 for 2 decimal places.
                const scaled = (bal * 10000n) / totalSupplyBig
                return `${(Number(scaled) / 100).toFixed(2)}%`
              } catch {
                return '—'
              }
            })()
            return (
              <tr key={holder.addr} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  <Link
                    href={`/address/${holder.addr}`}
                    className={`${chainConfig.theme.linkText} hover:underline`}
                  >
                    {holder.addr}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  {holderAmount} {symbol}
                </td>
                <td className="px-4 py-2 text-gray-600">{pct}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
