'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain-client'
import type { TokenTransferRow } from '@/lib/providers'
import { formatDecimalAmount, timeAgo, tokenText } from '@/lib/format'
import { shortHash } from '@/lib/address-display'
import { AddressLink } from '@/components/ui/AddressLink'
import { LinkInName } from '@/components/ui/LinkInName'

type TransfersResponse = {
  // TokenTransferRow, not ProviderTokenTransfer: the route serves a reduced
  // projection (no tokenName — the backfill table does not store it). This
  // component reads only txHash/blockTimestamp/from/to/tokenAddress/
  // tokenSymbol/valueFormatted, all of which the row carries.
  transfers: TokenTransferRow[]
  source?: 'local' | 'provider'
  complete?: boolean
  stale?: boolean
  cursor: string | null
  limited?: boolean
  reason?: string
}

/** One row of the provider's history. Exported so the cells can be rendered without the fetch. */
export function ProviderTransferRow({ t, addr }: { t: TokenTransferRow; addr: string }) {
  // The provider's symbol is sanitised like the server tab's, and one that reads as a URL or handle (lib/link-in-name)
  // keeps its text in the Token cell, badged, and is named by the token's short address after the amount.
  const text = tokenText(t.tokenSymbol, null, t.tokenAddress)
  const token = (
    <Link href={`/token/${t.tokenAddress}`} className={text.linkLike ? 'text-acc-ink hover:underline font-medium' : 'text-acc-ink hover:underline'}>
      {text.name}
    </Link>
  )
  return (
    <tr className="hover:bg-canvas transition-colors">
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        <Link href={`/tx/${t.txHash}`} className="text-acc-ink hover:underline">
          {shortHash(t.txHash)}
        </Link>
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px] text-mut hidden sm:table-cell">
        {timeAgo(new Date(t.blockTimestamp))}
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px] hidden sm:table-cell">
        <AddressLink address={t.fromAddress} self={t.fromAddress.toLowerCase() === addr} />
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px] hidden sm:table-cell">
        <AddressLink address={t.toAddress} self={t.toAddress.toLowerCase() === addr} />
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        {text.linkLike ? <>{token}<LinkInName className="ml-2" /></> : token}
      </td>
      <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
        {formatDecimalAmount(t.valueFormatted)}{text.symbol ? ` ${text.symbol}` : ''}
      </td>
    </tr>
  )
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
          <div key={i} className="h-9 bg-hair2 rounded" />
        ))}
      </div>
    )
  }

  return <TransfersView data={data} addr={addr} cursor={cursor} activeCursor={activeCursor} onCursor={setActiveCursor} />
}

/** The tab's content once the provider has answered (or failed). Split from the fetching so a test can render it. */
export function TransfersView({ data, addr, cursor, activeCursor, onCursor }: {
  data: TransfersResponse | null
  addr: string
  cursor: string | null
  activeCursor: string | null
  onCursor: (cursor: string | null) => void
}) {
  if (!data || data.limited) {
    const throttled = data?.reason === 'rate_limited' || data?.reason === 'upstream_error'
    return (
      <p className="text-mut">
        {throttled
          ? 'The data provider is busy right now — token transfer history is temporarily unavailable. Check back in a few minutes.'
          : 'Token transfer history is not available for this address.'}
      </p>
    )
  }

  if (data.transfers.length === 0) {
    return (
      <p className="text-mut">No token transfers found for this address.</p>
    )
  }

  const transfers = data.transfers

  return (
    <div>
      <div className="bg-card border border-hair border-l-[3px] border-l-acc rounded-xl px-4 py-3 mb-4 text-sm text-ink2 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0 text-acc-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>
        </svg>
        <span>Showing token transfer history from Moralis.</span>
      </div>
      <div className="bg-card rounded-xl border border-hair overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{chainConfig.name} token transfers for this address</caption>
            <thead className="bg-canvas border-b border-hair">
              <tr>
                <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Tx Hash</th>
                <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut hidden sm:table-cell">Age</th>
                <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut hidden sm:table-cell">From</th>
                <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut hidden sm:table-cell">To</th>
                <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Token</th>
                <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hair">
              {transfers.map((t) => (
                <ProviderTransferRow key={`${t.txHash}-${t.tokenAddress}`} t={t} addr={addr} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {/* Cursor pagination */}
      <div className="flex justify-center gap-4 mt-4">
        {activeCursor && (
          <button
            onClick={() => onCursor(null)}
            className="rounded-[9px] border border-hair bg-card px-3 py-1 font-mono text-[12.5px] text-ink transition-colors hover:border-hair3"
          >
            ← First Page
          </button>
        )}
        {cursor && (
          <button
            onClick={() => onCursor(cursor)}
            className="rounded-[9px] border border-hair bg-card px-3 py-1 font-mono text-[12.5px] text-ink transition-colors hover:border-hair3"
          >
            Next Page →
          </button>
        )}
      </div>
    </div>
  )
}
