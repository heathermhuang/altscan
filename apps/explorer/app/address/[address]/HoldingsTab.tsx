import { cache } from 'react'
import { inArray, sql } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { chainConfig } from '@/lib/chain'
import { getWebProvider } from '@/lib/rpc'
import { swallow } from '@/lib/observability'
import { holdingFromIndex, holdingsNote, mergeHoldings, priceTracked, trackedTokens, type HoldingRow } from '@/lib/holdings'
import { readTrackedBalances } from '@/lib/tracked-balances'
import { HoldingsLazy } from './HoldingsLazy'
import { HoldingsBanner, HoldingsTable } from './HoldingsTable'

/**
 * Live balances of the tracked tokens, one RPC read per request (the page's lead sentence and this
 * tab both ask). null = the read failed. See lib/tracked-balances.ts for why it is not the index.
 */
export const getTrackedBalances = cache(async (addr: string): Promise<Record<string, string> | null> => {
  try {
    return await readTrackedBalances(await getWebProvider(), addr, trackedTokens(chainConfig.whales))
  } catch (e) {
    swallow('addr/tracked-balances', e)
    return null
  }
})

export async function HoldingsTab({ addr, isBot, nativeUsd }: { addr: string; isBot: boolean; nativeUsd: number | null }) {
  const tokens = trackedTokens(chainConfig.whales)
  const balances = await getTrackedBalances(addr)
  const tracked = balances ? priceTracked(tokens, balances, nativeUsd) : null

  let indexRows: HoldingRow[] = []
  try {
    // The explorer's own balance index: instant, but a snapshot (per-block holder tracking is off), so
    // it carries no prices and is not trusted for the tracked tokens above.
    const result = await db.execute(sql`
      SELECT tb.token_address, tb.balance::text as balance
      FROM token_balances tb
      WHERE tb.holder_address = ${addr} AND tb.balance::numeric > 0
      ORDER BY tb.balance::numeric DESC
      LIMIT 50
    `)

    const rows = Array.from(result) as Record<string, unknown>[]
    const tokenAddresses = rows.map(r => String(r.token_address))
    const tokenInfos = tokenAddresses.length > 0
      ? await db.select({
          address: schema.tokens.address,
          name: schema.tokens.name,
          symbol: schema.tokens.symbol,
          decimals: schema.tokens.decimals,
        }).from(schema.tokens).where(inArray(schema.tokens.address, tokenAddresses))
      : []
    const tokenMap = new Map(tokenInfos.map(t => [t.address, t]))
    indexRows = rows.map((row) => {
      const tokenAddress = String(row.token_address)
      const tok = tokenMap.get(tokenAddress)
      return holdingFromIndex({
        tokenAddress,
        balance: String(row.balance),
        name: tok?.name ?? null,
        symbol: tok?.symbol ?? null,
        decimals: tok?.decimals ?? null,
      })
    })
  } catch (e) {
    swallow('addr/holdings', e)
    // DB error
  }

  const note = (others: 'index' | 'none') =>
    holdingsNote({ tracked: tokens, trackedKnown: tracked !== null, nativeSymbol: chainConfig.currency, nativePriced: nativeUsd !== null, others })

  if (indexRows.length === 0) {
    // Nothing in the index: the provider may still know this address. Bots get the local view only.
    if (!isBot) return <HoldingsLazy addr={addr} tracked={tracked} nativePriced={nativeUsd !== null} />
    if (!tracked || tracked.length === 0) return <p className="text-mut">No token holdings found for this address.</p>
    return (
      <div>
        <HoldingsBanner>{note('none')}</HoldingsBanner>
        <HoldingsTable rows={mergeHoldings(tracked, [])} caption={`${chainConfig.name} token holdings for this address`} nativeSymbol={chainConfig.currency} />
      </div>
    )
  }

  const rows = mergeHoldings(tracked ?? [], indexRows, tracked ? tokens.map((t) => t.address) : [])
  if (rows.length === 0) return <p className="text-mut">No token holdings found for this address.</p>
  return (
    <div>
      <HoldingsBanner>{note('index')}</HoldingsBanner>
      <HoldingsTable rows={rows} caption={`${chainConfig.name} token holdings for this address`} nativeSymbol={chainConfig.currency} />
    </div>
  )
}
