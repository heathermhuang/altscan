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
 * The local fallback nets the token's most recent LOCAL_HOLDERS_WINDOW transfers (steady holders
 * like exchanges missing) — surfaced as source:'local' so the page labels it an estimate, not real
 * balances. It also covers Moralis being rate-limited / disabled (MORALIS_DISABLED) / keyless.
 */
import { db } from './db'
import { sql } from 'drizzle-orm'
import { getDataProvider } from './providers'
import { TOKEN_HOLDERS_PAGE_SIZE } from '@altscan/providers'
import type { ProviderAdapter, ProviderResult, TokenHoldersPage } from './providers'

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
  /**
   * The provider's own total supply (raw base units, a decimal string: JSON-safe, never a bigint), read with the
   * balances above. Only on 'moralis'. It is the denominator for their shares: the token row's supply was captured
   * at discovery and is healed only when 0, so it is stale for a minting, burning or rebasing token. null/absent
   * = the provider did not say; the consumer then falls back to the row's (lib/holder-share.ts holdersSupply).
   */
  totalSupply?: string | null
}

export const EMPTY_HOLDERS: HoldersResult = { holders: [], holderCount: null, source: 'local' }

/**
 * How many of a token's most recent transfers the local estimate nets. The old query grouped
 * EVERY retained transfer of the token with no window: >20s for USDT on both chains (BNB >5M
 * rows, ETH 2.5M), cancelled only by the DB statement timeout, and the page's 6s withTimeout
 * left it running on every view. Over the latest 10,000 it measured 24 ms on BNB and 249 ms
 * cold / 20 ms warm on ETH. HoldersLazy's estimate banner states this number.
 */
export const LOCAL_HOLDERS_WINDOW = 10_000

/**
 * How many rows the local estimate returns: the provider's page size, so HoldersLazy's swap from
 * the SSR estimate to the live holders changes values, not the table's height (was LIMIT 10 against
 * the provider's 25: a 15-row layout shift on every token page view, CLS ~0.19 on USDT).
 */
export const LOCAL_HOLDERS_LIMIT = TOKEN_HOLDERS_PAGE_SIZE

/**
 * Top net-receivers over the token's most recent LOCAL_HOLDERS_WINDOW transfers.
 *
 * The window's ORDER BY is the token page's transfer list order (token-transfers-query.ts):
 * `(timestamp DESC, block_number DESC)` walks `(token_address, timestamp DESC)` and stops after
 * the limit, instead of reading every transfer of the token. The window is a literal, not a bound
 * parameter, so the planner always sees the LIMIT it has to honor.
 */
export function buildLocalNetFlowQuery(tokenAddr: string) {
  return sql`
    WITH recent AS (
      SELECT from_address, to_address, value::numeric AS v
      FROM token_transfers
      WHERE token_address = ${tokenAddr}
      ORDER BY timestamp DESC, block_number DESC
      LIMIT ${sql.raw(String(LOCAL_HOLDERS_WINDOW))}
    ),
    flows AS (
      SELECT to_address AS addr, v FROM recent
      UNION ALL
      SELECT from_address AS addr, -v FROM recent
    )
    SELECT addr, SUM(v)::text AS balance
    FROM flows
    GROUP BY addr
    HAVING SUM(v) > 0
    ORDER BY SUM(v) DESC
    LIMIT ${sql.raw(String(LOCAL_HOLDERS_LIMIT))}
  `
}

/**
 * Local fallback: top net-receivers from the token's latest transfers — a net-flow window, NOT
 * real balances — surfaced via source:'local' so the page labels it an estimate.
 */
async function fetchLocalNetFlowHolders(tokenAddr: string): Promise<HoldersResult> {
  try {
    const result = await db.execute(buildLocalNetFlowQuery(tokenAddr))
    const holders = Array.from(result).map((row) => ({
      addr: String((row as Record<string, unknown>).addr),
      balance: String((row as Record<string, unknown>).balance),
    }))
    return { holders, holderCount: null, source: 'local' }
  } catch {
    return EMPTY_HOLDERS
  }
}

/** Pure: provider result pair → HoldersResult, or null → caller uses the local
 *  fallback. `source` keeps the literal 'moralis' — it's the UI contract for
 *  "real balances" labeling, not a vendor reference. */
export function holdersFromProvider(
  owners: ProviderResult<TokenHoldersPage>,
  count: ProviderResult<number> | null,
): HoldersResult | null {
  if (!owners.ok || owners.data.holders.length === 0) return null
  return {
    holders: owners.data.holders.map((h) => ({
      addr: h.address,
      balance: h.balance,
      usdValue: h.usdValue,
      isContract: h.isContract,
      label: h.label,
    })),
    holderCount: count && count.ok ? count.data : null,
    source: 'moralis',
    totalSupply: owners.data.totalSupply,
  }
}

/**
 * Orchestrator: accurate provider holders when available, else the labeled
 * local estimate. The adapter is cached + rate-limited + kill-switchable
 * internally; a failure of ANY reason (disabled / keyless / rate-limited /
 * upstream) → local fallback — same behavior the old null contract gave,
 * now spelled out. `deps.provider` is injectable for tests.
 */
export async function getTokenHolders(
  addr: string,
  opts?: { skipProvider?: boolean },
  deps?: { provider?: ProviderAdapter | null },
): Promise<HoldersResult> {
  if (!opts?.skipProvider) {
    const provider = deps?.provider !== undefined ? deps.provider : getDataProvider()
    if (provider) {
      const owners = await provider.getTokenHolders(addr)
      const count = owners.ok && owners.data.holders.length > 0
        ? await provider.getTokenHolderCount(addr).catch(() => null)
        : null
      const fromProvider = holdersFromProvider(owners, count)
      if (fromProvider) return fromProvider
    }
  }
  return fetchLocalNetFlowHolders(addr)
}
