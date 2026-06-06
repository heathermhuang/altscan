/**
 * Token holders — accurate top holders + real holder count from Moralis (already wired, Pro),
 * with graceful fallback to a clearly-labeled local net-flow estimate.
 *
 * WHY MORALIS: token_balances writes are hardcoded-disabled in the indexer
 * (block-processor.ts SKIP_HOLDER_BALANCES) to prevent a write-storm, so there is NO maintained
 * local holder table and tokens.holderCount is frozen. Moralis /erc20/{addr}/owners returns real
 * balances (highest-first, with USD value, %-of-supply, contract flag/label) and
 * /erc20/{addr}/holders returns the real total count. Both reuse the shared Moralis
 * auth/limiter/KV-cache/kill-switch in ./moralis — no new vendor, no new secret.
 *
 * The local fallback aggregates token_transfers, which under ~1-day retention is only a ~24h
 * NET-FLOW window (steady holders like exchanges missing) — surfaced as source:'local' so the
 * page labels it an estimate, not real balances. It also covers Moralis being rate-limited /
 * disabled (MORALIS_DISABLED) / keyless.
 */
import { db } from './db'
import { sql } from 'drizzle-orm'
import { getTokenOwners, getTokenHolderCount } from './moralis'

export type TokenHolder = {
  addr: string
  balance: string
  usdValue?: string | null
  isContract?: boolean
  label?: string | null
}
export type HoldersResult = {
  holders: TokenHolder[]
  holderCount: number | null      // real total from Moralis; null when unknown
  source: 'moralis' | 'local'     // 'local' = net-flow estimate, NOT real balances
}

export const EMPTY_HOLDERS: HoldersResult = { holders: [], holderCount: null, source: 'local' }

/**
 * Local fallback: top net-receivers from token_transfers. Under ~1-day retention this is a
 * ~24h NET-FLOW window, NOT real balances — surfaced via source:'local' so the page labels it
 * an estimate. (Moved verbatim from the old in-page fetchTopHolders.)
 */
async function fetchLocalNetFlowHolders(tokenAddr: string): Promise<HoldersResult> {
  try {
    const result = await db.execute(sql`
      WITH inflows AS (
        SELECT to_address as addr, SUM(value::numeric) as total
        FROM token_transfers WHERE token_address = ${tokenAddr} GROUP BY 1
      ),
      outflows AS (
        SELECT from_address as addr, SUM(value::numeric) as total
        FROM token_transfers WHERE token_address = ${tokenAddr} GROUP BY 1
      )
      SELECT i.addr, (COALESCE(i.total, 0) - COALESCE(o.total, 0))::text as balance
      FROM inflows i
      LEFT JOIN outflows o ON i.addr = o.addr
      WHERE (COALESCE(i.total, 0) - COALESCE(o.total, 0)) > 0
      ORDER BY balance DESC
      LIMIT 10
    `)
    const holders = Array.from(result).map((row) => ({
      addr: String((row as Record<string, unknown>).addr),
      balance: String((row as Record<string, unknown>).balance),
    }))
    return { holders, holderCount: null, source: 'local' }
  } catch {
    return EMPTY_HOLDERS
  }
}

/**
 * Orchestrator: accurate Moralis holders when available, else the labeled local estimate.
 * getTokenOwners is cached + rate-limited + kill-switchable internally and returns null when
 * disabled / keyless / rate-limited / errored → we fall back to the local estimate.
 */
export async function getTokenHolders(addr: string): Promise<HoldersResult> {
  const owners = await getTokenOwners(addr)
  if (owners && owners.holders.length > 0) {
    const holderCount = await getTokenHolderCount(addr).catch(() => null)
    return {
      holders: owners.holders.map((h) => ({
        addr: h.address,
        balance: h.balance,
        usdValue: h.usdValue,
        isContract: h.isContract,
        label: h.label,
      })),
      holderCount,
      source: 'moralis',
    }
  }
  return fetchLocalNetFlowHolders(addr)
}
