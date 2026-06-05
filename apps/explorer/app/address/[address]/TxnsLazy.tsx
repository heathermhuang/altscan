'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain-client'
import type { MoralisTx } from '@/lib/moralis'
import { formatNumber, timeAgo } from '@/lib/format'

type HistoryResponse = {
  result: MoralisTx[]
  cursor: string | null
  totalTxs?: number
  limited?: boolean
}

export function TxnsLazy({ addr }: { addr: string }) {
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState<string | null>(null)
  const [activeCursor, setActiveCursor] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    const url = activeCursor
      ? `/api/internal/address/${addr}/history?cursor=${encodeURIComponent(activeCursor)}`
      : `/api/internal/address/${addr}/history`
    fetch(url)
      .then((r) => r.json())
      .then((d: HistoryResponse) => {
        setData(d)
        setCursor(d.cursor ?? null)
      })
      .catch(() => setData({ result: [], cursor: null, limited: true }))
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

  if (!data || data.limited || data.result.length === 0) {
    return (
      <p className="text-gray-500">
        Transaction history is not available in the local index for this address.
      </p>
    )
  }

  const txs = data.result
  const total = data.totalTxs ?? 0

  return (
    <div>
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>
        </svg>
        <span>
          Showing transaction history via Moralis
          {total > 0 && ` — ${formatNumber(total)} total transactions`}
        </span>
      </div>
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Tx Hash</th>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">Age</th>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Summary</th>
                <th className="text-left px-3 sm:px-4 py-2 font-medium text-gray-500">Value ({chainConfig.currency})</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {txs.map((tx) => (
                <tr key={tx.hash} className={`hover:bg-gray-50 ${tx.possibleSpam ? 'opacity-50' : ''}`}>
                  <td className="px-3 sm:px-4 py-2 font-mono text-xs">
                    <Link href={`/tx/${tx.hash}`} className={`${chainConfig.theme.linkText} hover:underline`}>
                      {tx.hash.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-3 sm:px-4 py-2 text-gray-500 text-xs hidden sm:table-cell">
                    {timeAgo(new Date(tx.blockTimestamp))}
                  </td>
                  <td className="px-3 sm:px-4 py-2 text-gray-700 text-xs max-w-xs truncate">
                    {tx.summary || tx.category}
                  </td>
                  <td className="px-3 sm:px-4 py-2 text-xs">
                    {(Number(tx.value) / 1e18).toFixed(6)}
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
