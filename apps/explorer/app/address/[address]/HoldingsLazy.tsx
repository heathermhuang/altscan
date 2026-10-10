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
function HoldingsNote({ tracked }: { tracked: HoldingRow[] | null }) {
  return (
    <HoldingsBanner>
      {holdingsNote({ tracked: trackedTokens(chainConfig.whales), trackedKnown: tracked !== null, nativeSymbol: chainConfig.currency, others: 'moralis' })}
    </HoldingsBanner>
  )
}

/**
 * The tab's content once the provider has answered (or failed). `tracked` is the page's live read of
 * the tracked tokens (USDT, USDC, the wrapped token), already priced; null = that read failed. They
 * are merged into whatever the provider lists, which may leave them out.
 */
export function HoldingsView({ data, tracked }: { data: HoldingsResponse | null; tracked: HoldingRow[] | null }) {
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
      <HoldingsNote tracked={tracked} />
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

export function HoldingsLazy({ addr, tracked }: { addr: string; tracked: HoldingRow[] | null }) {
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
        <HoldingsNote tracked={tracked} />
        <div className="animate-pulse space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-9 bg-hair2 rounded" />
          ))}
        </div>
      </div>
    )
  }

  return <HoldingsView data={data} tracked={tracked} />
}
