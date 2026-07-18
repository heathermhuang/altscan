'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain-client'
import type { ProviderTokenTransfer } from '@/lib/providers'
import { timeAgo, formatAddress } from '@/lib/format'

type TransfersResponse = {
  transfers: ProviderTokenTransfer[]
  cursor: string | null
  limited?: boolean
  reason?: string
}

export function TransfersLazy({ addr }: { addr: string }) {
  const [data, setData] = useState<TransfersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState<string | null>(null)
  const [activeCursor, setActiveCursor] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    const url = activeCursor
      ? `/api/internal/address/${addr}/transfers?cursor=${encodeURIComponent(activeCursor)}`
      : `/api/internal/address/${addr}/transfers`
    fetch(url)
      .then((r) => r.json())
      .then((d: TransfersResponse) => {
        setData(d)
        setCursor(d.cursor ?? null)
      })
      .catch(() => setData({ transfers: [], cursor: null, limited: true }))
      .finally(() => setLoading(false))
  }, [addr, activeCursor])

  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-9 bg-gray-100 rounded" />
        ))}
      </div>
    )
  }

  if (!data || data.limited) {
    const throttled = data?.reason === 'rate_limited' || data?.reason === 'upstream_error'
    return (
      <p className="text-gray-500">
        {throttled
          ? 'The data provider is busy right now — token transfer history is temporarily unavailable. Check back in a few minutes.'
          : 'Token transfer history is not available for this address.'}
      </p>
    )
  }

  if (data.transfers.length === 0) {
    return (
      <p className="text-gray-500">No token transfers found for this address.</p>
    )
  }

  const transfers = data.transfers

  return (
    <div>
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>
        </svg>
        <span>Showing token transfer history from Moralis.</span>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Tx Hash</th>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">Age</th>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">From</th>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">To</th>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Token</th>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {transfers.map((t) => (
                <tr key={`${t.txHash}-${t.tokenAddress}`} className="hover:bg-gray-50">
                  <td className="px-3 sm:px-4 py-2 font-mono text-xs">
                    <Link href={`/tx/${t.txHash}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {t.txHash.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-3 sm:px-4 py-2 text-gray-500 text-xs hidden sm:table-cell">
                    {timeAgo(new Date(t.blockTimestamp))}
                  </td>
                  <td className="px-3 sm:px-4 py-2 font-mono text-xs hidden sm:table-cell">
                    <Link
                      href={`/address/${t.fromAddress}`}
                      className={t.fromAddress.toLowerCase() === addr ? 'text-gray-800 font-semibold' : `${chainConfig.theme.linkText} hover:underline`}
                    >
                      {formatAddress(t.fromAddress)}
                    </Link>
                  </td>
                  <td className="px-3 sm:px-4 py-2 font-mono text-xs hidden sm:table-cell">
                    <Link
                      href={`/address/${t.toAddress}`}
                      className={t.toAddress.toLowerCase() === addr ? 'text-gray-800 font-semibold' : `${chainConfig.theme.linkText} hover:underline`}
                    >
                      {formatAddress(t.toAddress)}
                    </Link>
                  </td>
                  <td className="px-3 sm:px-4 py-2 text-xs">
                    <Link href={`/token/${t.tokenAddress}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {t.tokenSymbol || formatAddress(t.tokenAddress)}
                    </Link>
                  </td>
                  <td className="px-3 sm:px-4 py-2 text-xs">
                    {parseFloat(t.valueFormatted).toLocaleString(undefined, { maximumFractionDigits: 6 })} {t.tokenSymbol}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {/* Cursor pagination */}
      <div className="flex justify-center gap-4 mt-4">
        {activeCursor && (
          <button
            onClick={() => setActiveCursor(null)}
            className={`text-sm ${chainConfig.theme.linkText} hover:underline border ${chainConfig.theme.border} rounded px-3 py-1`}
          >
            ← First Page
          </button>
        )}
        {cursor && (
          <button
            onClick={() => setActiveCursor(cursor)}
            className={`text-sm ${chainConfig.theme.linkText} hover:underline border ${chainConfig.theme.border} rounded px-3 py-1`}
          >
            Next Page →
          </button>
        )}
      </div>
    </div>
  )
}
