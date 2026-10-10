'use client'

import { useEffect, useState } from 'react'
import { chainConfig } from '@/lib/chain-client'
import type { HistoryRow } from '@/lib/providers'
import { formatNumber } from '@/lib/format'
import { AddressLedger, AddressLedgerShell } from '@/components/tape/AddressLedger'
import { TxnsTable } from './TxnsTable'
import { toLedgerRows } from '@/lib/ledger'

type HistoryResponse = {
  // HistoryRow, not ProviderTx: the route serves a reduced projection so a
  // backfilled row and a live provider row are the same shape. This component
  // only ever read these fields, so it is a tightening, not a change.
  result: HistoryRow[]
  cursor: string | null
  totalTxs?: number
  limited?: boolean
  reason?: string
  /** Which side served this page. Absent when backfill is disabled (A4a). */
  source?: 'local' | 'provider'
  /** True only when the cached tail is exhausted AND the entity is fully backfilled. */
  complete?: boolean
  /** Set when the provider was unreachable and we served the cache instead. */
  stale?: boolean
}

/** `reserveLedger`: whether a ledger can draw once the rows arrive (it needs 2), so the loading state
 *  holds its card; false (an address known to have exactly one tx) leaves just the skeleton rows. */
export function TxnsLazy({ addr, reserveLedger }: { addr: string; reserveLedger: boolean }) {
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
      <div>
        {reserveLedger && <AddressLedgerShell currency={chainConfig.currency} />}
        <div className="animate-pulse space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-9 bg-hair2 rounded" />
          ))}
        </div>
      </div>
    )
  }

  if (!data || data.limited) {
    const throttled = data?.reason === 'rate_limited' || data?.reason === 'upstream_error'
    return (
      <p className="text-mut">
        {throttled
          ? 'The history provider is busy right now — full transaction history is temporarily unavailable. Check back in a few minutes.'
          : 'Transaction history is not available in the local index for this address.'}
      </p>
    )
  }

  if (data.result.length === 0) {
    return <p className="text-mut">No transactions found for this address.</p>
  }

  const txs = data.result
  const total = data.totalTxs ?? 0

  return (
    <div>
      <div className="bg-card border border-hair border-l-[3px] border-l-acc rounded-xl px-4 py-3 mb-4 text-sm text-ink2 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0 text-acc-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>
        </svg>
        <span>
          {data.stale
            ? 'Showing cached transaction history — live lookup is temporarily unavailable'
            : data.source === 'local'
              ? (data.complete
                  ? 'Showing full transaction history from our local index'
                  : 'Showing older transaction history from our local index')
              : 'Showing transaction history via Moralis'}
          {total > 0 && ` — ${formatNumber(total)} total transactions`}
        </span>
      </div>
      <AddressLedger
        rows={toLedgerRows(addr, txs.map(t => ({ time: t.blockTimestamp, fromAddress: t.fromAddress, toAddress: t.toAddress, value: t.value, category: t.category, possibleSpam: t.possibleSpam, block: t.blockNumber })))}
        currency={chainConfig.currency}
      />
      <div className="bg-card rounded-xl border border-hair overflow-hidden">
        <div className="overflow-x-auto">
          <TxnsTable
            caption={`${chainConfig.name} transaction history for this address`}
            currency={chainConfig.currency}
            detailHeading="Summary"
            detailClass="font-sans text-ink2 max-w-xs truncate"
            unitInHeading
            rows={txs.map((tx) => ({
              hash: tx.hash,
              timestamp: tx.blockTimestamp,
              detail: tx.summary || tx.category,
              value: tx.value,
              faded: tx.possibleSpam,
            }))}
          />
        </div>
      </div>
      {/* Cursor pagination */}
      <div className="flex justify-center gap-4 mt-4">
        {activeCursor && (
          <button
            onClick={() => setActiveCursor(null)}
            className="rounded-[9px] border border-hair bg-card px-3 py-1 font-mono text-[12.5px] text-ink transition-colors hover:border-hair3"
          >
            ← First Page
          </button>
        )}
        {cursor && (
          <button
            onClick={() => setActiveCursor(cursor)}
            className="rounded-[9px] border border-hair bg-card px-3 py-1 font-mono text-[12.5px] text-ink transition-colors hover:border-hair3"
          >
            Next Page →
          </button>
        )}
      </div>
    </div>
  )
}
