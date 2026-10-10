'use client'

import { useEffect, useState } from 'react'
import { chainConfig } from '@/lib/chain-client'
import type { ProviderTokenBalance } from '@/lib/providers'
import { holdingFromProvider, holdingsNote, mergeHoldings, trackedTokens, type HoldingRow } from '@/lib/holdings'
import { HoldingsBanner, HoldingsTable } from './HoldingsTable'

type HoldingsResponse = {
  tokens: ProviderTokenBalance[]
  limited?: boolean
  reason?: string
}

/**
 * The line above the tab's content. It does not depend on the provider's answer (that is what the
 * words "where it answers" are for), so it is drawn from the first paint and the swap from skeleton
 * to table never changes its height.
 */
function HoldingsNote({ tracked, nativePriced }: { tracked: HoldingRow[] | null; nativePriced: boolean }) {
  return (
    <HoldingsBanner>
      {holdingsNote({ tracked: trackedTokens(chainConfig.whales), trackedKnown: tracked !== null, nativeSymbol: chainConfig.currency, nativePriced, others: 'moralis' })}
    </HoldingsBanner>
  )
}

/**
 * The tab's content once the provider has answered (or failed). `tracked` is the page's live read of
 * the tracked tokens (USDT, USDC, the wrapped token), already priced; null = that read failed.
 * `nativePriced`: whether the page had a native price for the wrapped token. They
 * are merged into whatever the provider lists, which may leave them out.
 */
export function HoldingsView({ data, tracked, nativePriced }: { data: HoldingsResponse | null; tracked: HoldingRow[] | null; nativePriced: boolean }) {
  const providerOk = !!data && !data.limited
  const known = tracked !== null
  const tokens = trackedTokens(chainConfig.whales)
  const rows = mergeHoldings(tracked ?? [], providerOk ? data.tokens.map(holdingFromProvider) : [], known ? tokens.map((t) => t.address) : [])
  const throttled = data?.reason === 'rate_limited' || data?.reason === 'upstream_error'
  const unavailable = throttled
    ? 'The data provider is busy right now — token holdings are temporarily unavailable. Check back in a few minutes.'
    : 'Token holdings are not available for this address.'

  return (
    <div>
      <HoldingsNote tracked={tracked} nativePriced={nativePriced} />
      {rows.length === 0 ? (
        <p className="text-mut">{providerOk ? 'No token holdings found for this address.' : unavailable}</p>
      ) : (
        <>
          <HoldingsTable rows={rows} caption={`${chainConfig.name} token holdings for this address`} nativeSymbol={chainConfig.currency} />
          {!providerOk && <p className="mt-3 text-sm text-mut">Other token holdings are not available right now.</p>}
        </>
      )}
    </div>
  )
}

export function HoldingsLazy({ addr, tracked, nativePriced }: { addr: string; tracked: HoldingRow[] | null; nativePriced: boolean }) {
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
      <div>
        <HoldingsNote tracked={tracked} nativePriced={nativePriced} />
        {/* The table's own box and row height (header + 5 rows of 37 px), so a five-row answer replaces it
            without moving what is below. */}
        <div className="animate-pulse bg-card rounded-xl border border-hair overflow-hidden divide-y divide-hair">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-[37px] bg-hair2" />
          ))}
        </div>
      </div>
    )
  }

  return <HoldingsView data={data} tracked={tracked} nativePriced={nativePriced} />
}
