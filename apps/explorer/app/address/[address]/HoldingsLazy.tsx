'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain-client'
import type { ProviderTokenBalance } from '@/lib/providers'
import { tokenTextOr, UNKNOWN_TOKEN } from '@/lib/format'

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
          <div key={i} className="h-9 bg-hair2 rounded" />
        ))}
      </div>
    )
  }

  if (!data || data.limited) {
    const throttled = data?.reason === 'rate_limited' || data?.reason === 'upstream_error'
    return (
      <p className="text-mut">
        {throttled
          ? 'The data provider is busy right now — token holdings are temporarily unavailable. Check back in a few minutes.'
          : 'Token holdings are not available for this address.'}
      </p>
    )
  }

  if (data.tokens.length === 0) {
    return (
      <p className="text-mut">No token holdings found for this address.</p>
    )
  }

  const tokens = data.tokens

  return (
    <div>
      <div className="bg-card border border-hair border-l-[3px] border-l-acc rounded-xl px-4 py-3 mb-4 text-sm text-ink2 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0 text-acc-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>
        </svg>
        <span>Showing current token holdings from Moralis.</span>
      </div>
      <div className="bg-card rounded-xl border border-hair overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{chainConfig.name} token holdings for this address</caption>
          <thead className="bg-canvas border-b border-hair">
            <tr>
              <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Token</th>
              <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Symbol</th>
              <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Balance</th>
              <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">USD Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hair">
            {tokens.map((t) => (
              <tr key={t.tokenAddress} className="hover:bg-canvas transition-colors">
                <td className="px-3 sm:px-4 py-2">
                  <Link href={`/token/${t.tokenAddress}`} className="text-acc-ink hover:underline font-medium">
                    {tokenTextOr(t.name, UNKNOWN_TOKEN)}
                  </Link>
                </td>
                <td className="px-3 sm:px-4 py-2 font-mono text-[13px] text-ink2">{t.symbol ?? '—'}</td>
                <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
                  {(() => {
                    const f = parseFloat(t.balanceFormatted ?? '')
                    if (!isNaN(f)) return f.toLocaleString('en-US', { maximumFractionDigits: 6 })
                    try {
                      const raw = BigInt(t.balance)
                      const d = 10n ** BigInt(t.decimals)
                      return (Number(raw / d) + Number(raw % d) / Number(d)).toLocaleString('en-US', { maximumFractionDigits: 6 })
                    } catch { return '—' }
                  })()}
                </td>
                <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
                  {t.usdValue ? `$${parseFloat(t.usdValue).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
