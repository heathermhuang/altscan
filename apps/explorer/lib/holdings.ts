/**
 * The address page's token holdings, as rows with an honest USD column.
 *
 * Two sources feed the Holdings tab and they disagree about what they can say:
 *  - the TRACKED tokens (the chain's stablecoins and wrapped native, from chain-config) are read
 *    live from the chain (lib/tracked-balances.ts), so their balance is exact and their price is
 *    known: a stablecoin is $1, matched by contract address (never by symbol), the wrapped token is
 *    the native coin's live price. These rows are `tracked: true`.
 *  - everything else comes from the explorer's index (`token_balances`, a snapshot with no prices) or
 *    from Moralis (which may carry its own USD value). A row is priced only if its source priced it;
 *    otherwise it reads "no price". A number here is real or labelled, never invented.
 *
 * Pure and light: the Holdings tab (client) imports it. Nothing here holds a BigInt past a call.
 */
import { formatCompactUsd, formatDecimalAmount, formatTokenAmount } from './format'
import type { ProviderTokenBalance } from './providers'

export type TrackedToken = { address: string; symbol: string; decimals: number; kind: 'stablecoin' | 'wrapped' }

/** Where a row's USD value came from: a $1 stablecoin, the native coin's price, or the data provider. */
export type HoldingBasis = 'stablecoin' | 'native' | 'provider'

export type HoldingRow = {
  tokenAddress: string
  name: string | null
  symbol: string | null
  decimals: number | null
  /** Raw base units, as a decimal string. */
  balance: string
  /** Display text, already formatted. */
  amount: string
  /** null = no price: the cell reads "no price". */
  usd: number | null
  basis: HoldingBasis | null
  tracked: boolean
}

/** The tokens whose balance is read live and priced: the chain's stablecoins and wrapped native token. */
export function trackedTokens(whales: {
  stablecoins: readonly { address: string; symbol: string; decimals: number }[]
  wrapped: { address: string; symbol: string; decimals: number }
}): TrackedToken[] {
  return [
    ...whales.stablecoins.map((s) => ({ address: s.address.toLowerCase(), symbol: s.symbol, decimals: s.decimals, kind: 'stablecoin' as const })),
    { address: whales.wrapped.address.toLowerCase(), symbol: whales.wrapped.symbol, decimals: whales.wrapped.decimals, kind: 'wrapped' as const },
  ]
}

function toUnits(raw: bigint, decimals: number): number {
  const d = 10n ** BigInt(decimals)
  return Number(raw / d) + Number(raw % d) / Number(d)
}

/**
 * Rows for the tracked tokens with a balance. `balances` maps lowercase contract address -> raw
 * balance (lib/tracked-balances.ts); a token it does not name, or names with 0, gets no row.
 * The wrapped token is unpriced when there is no native price.
 */
export function priceTracked(
  tokens: readonly TrackedToken[],
  balances: Readonly<Record<string, string>>,
  nativeUsd: number | null,
): HoldingRow[] {
  const rows: HoldingRow[] = []
  for (const t of tokens) {
    const raw = balances[t.address]
    if (raw === undefined) continue
    let units: bigint
    try { units = BigInt(raw) } catch { continue }
    if (units <= 0n) continue
    const priced = t.kind === 'stablecoin' ? 1 : nativeUsd
    rows.push({
      tokenAddress: t.address,
      name: t.symbol,
      symbol: t.symbol,
      decimals: t.decimals,
      balance: raw,
      amount: formatTokenAmount(units, t.decimals, 6),
      usd: priced === null ? null : toUnits(units, t.decimals) * priced,
      basis: priced === null ? null : t.kind === 'stablecoin' ? 'stablecoin' : 'native',
      tracked: true,
    })
  }
  return rows
}

/** A row from the explorer's own index (`token_balances`): a balance, never a price. */
export function holdingFromIndex(r: {
  tokenAddress: string
  balance: string
  name: string | null
  symbol: string | null
  decimals: number | null
}): HoldingRow {
  return {
    tokenAddress: r.tokenAddress.toLowerCase(),
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals,
    balance: r.balance,
    amount: r.decimals !== null ? formatTokenAmount(r.balance, r.decimals, 6) : r.balance.slice(0, 18),
    usd: null,
    basis: null,
    tracked: false,
  }
}

/** A row from the data provider's balances response, which may carry its own USD value. */
export function holdingFromProvider(t: ProviderTokenBalance): HoldingRow {
  const usd = t.usdValue == null || t.usdValue === '' ? NaN : Number(t.usdValue)
  const priced = Number.isFinite(usd) && usd >= 0
  // The raw balance and decimals are exact, so they come first. The provider's formatted string is for when
  // they are unusable, and goes through the same floor; it is never read through a float (that prints
  // dust as "0" and loses digits past 2^53).
  const rawUsable = /^\d+$/.test(t.balance) && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 255
  return {
    tokenAddress: t.tokenAddress.toLowerCase(),
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    balance: t.balance,
    amount: !rawUsable && t.balanceFormatted ? formatDecimalAmount(t.balanceFormatted) : formatTokenAmount(t.balance, t.decimals, 6),
    usd: priced ? usd : null,
    basis: priced ? 'provider' : null,
    tracked: false,
  }
}

/**
 * The tracked rows (live) and the other source's rows as one list: a token the other source also
 * names appears once, as the live tracked row (or not at all, if the live read settled it at zero).
 * Largest USD value first, unpriced rows after, each group keeping its incoming order.
 */
export function mergeHoldings(
  tracked: readonly HoldingRow[],
  others: readonly HoldingRow[],
  settled: readonly string[] = tracked.map((r) => r.tokenAddress),
): HoldingRow[] {
  // `settled`: tokens the live read answered for, INCLUDING a zero (which has no tracked row). The
  // other source must not bring back a balance the chain just said is gone.
  const seen = new Set([...tracked.map((r) => r.tokenAddress), ...settled].map((a) => a.toLowerCase()))
  const rows = [...tracked]
  for (const r of others) {
    const a = r.tokenAddress.toLowerCase()
    if (seen.has(a)) continue
    seen.add(a)
    rows.push(r)
  }
  return rows.sort((a, b) => (a.usd === null ? (b.usd === null ? 0 : 1) : b.usd === null ? -1 : b.usd - a.usd))
}

/** Below this the clause is dust, and the native balance's own USD figure uses the same floor. */
const DUST_USD = 0.1

/**
 * The address page lead's second clause: "and $600.01M in tracked tokens (USDT, WBNB)". It states
 * the priced value of the tracked tokens only, and names them: it is not the address's portfolio.
 * null when there is nothing priced to say, so the sentence stays as it was.
 */
export function trackedClause(tracked: readonly HoldingRow[]): string | null {
  const priced = tracked.filter((r) => r.usd !== null && r.usd > 0).sort((a, b) => b.usd! - a.usd!)
  const total = priced.reduce((sum, r) => sum + r.usd!, 0)
  if (!(total >= DUST_USD)) return null
  return `and ${formatCompactUsd(total)} in tracked tokens (${priced.map((r) => r.symbol).join(', ')})`
}

/** The USD cell: a dollar amount, or "no price". */
export function usdText(r: Pick<HoldingRow, 'usd'>): string {
  return r.usd === null ? 'no price' : `$${r.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/**
 * The one line above the holdings table saying where each kind of number comes from. `others` is
 * the source of the untracked rows: the explorer's index, Moralis, or 'none' (a crawler's view).
 */
export function holdingsNote(o: {
  tracked: readonly TrackedToken[]
  trackedKnown: boolean
  nativeSymbol: string
  /** Whether the native coin's live price was available: the wrapped token is only priced if it was. */
  nativePriced: boolean
  others: 'index' | 'moralis' | 'none'
}): string {
  const names = list(o.tracked.map((t) => t.symbol))
  const wrapped = o.tracked.find((t) => t.kind === 'wrapped')?.symbol ?? 'the wrapped token'
  const lead = !o.trackedKnown
    ? `${names} could not be read from the chain right now.`
    : o.nativePriced
      ? `${names} are read from the chain just now: stablecoins at $1, ${wrapped} at the live ${o.nativeSymbol} price.`
      : `${names} are read from the chain just now: stablecoins at $1; ${wrapped} has no price right now.`
  const rest = {
    index: " Other balances come from this explorer's index, a stale snapshot, and are not priced.",
    moralis: ' Other balances come from Moralis where it answers, priced only where it has a price.',
    none: '',
  }[o.others]
  return lead + rest
}
