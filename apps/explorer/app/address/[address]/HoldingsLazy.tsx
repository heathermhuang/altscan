'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain-client'
import type { ProviderTokenBalance } from '@/lib/providers'

type HoldingsResponse = {
  tokens: ProviderTokenBalance[]
  limited?: boolean
  reason?: string
}

export function HoldingsLazy({ addr }: { addr: string }) {
  const [data, setData] = useState<HoldingsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/internal/address/${addr}/holdings`)
      .then((r) => r.json())
      .then((d: HoldingsResponse) => setData(d))
      .catch(() => setData({ tokens: [], limited: true }))
      .finally(() => setLoading(false))
  }, [addr])

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
          ? 'The data provider is busy right now — token holdings are temporarily unavailable. Check back in a few minutes.'
          : 'Token holdings are not available for this address.'}
      </p>
    )
  }

  if (data.tokens.length === 0) {
    return (
      <p className="text-gray-500">No token holdings found for this address.</p>
    )
  }

  const tokens = data.tokens

  return (
    <div>
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>
        </svg>
        <span>Showing current token holdings from Moralis.</span>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-gray-500">Token</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500">Symbol</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500">Balance</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500">USD Value</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {tokens.map((t) => (
              <tr key={t.tokenAddress} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  <Link href={`/token/${t.tokenAddress}`} className={`${chainConfig.theme.linkText} hover:underline font-medium`}>
                    {t.name ?? t.tokenAddress.slice(0, 14) + '…'}
                  </Link>
                </td>
                <td className="px-4 py-2 text-gray-600">{t.symbol ?? '—'}</td>
                <td className="px-4 py-2">
                  {(() => {
                    const f = parseFloat(t.balanceFormatted ?? '')
                    if (!isNaN(f)) return f.toLocaleString(undefined, { maximumFractionDigits: 6 })
                    try {
                      const raw = BigInt(t.balance)
                      const d = 10n ** BigInt(t.decimals)
                      return (Number(raw / d) + Number(raw % d) / Number(d)).toLocaleString(undefined, { maximumFractionDigits: 6 })
                    } catch { return '—' }
                  })()}
                </td>
                <td className="px-4 py-2">
                  {t.usdValue ? `$${parseFloat(t.usdValue).toFixed(2)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
