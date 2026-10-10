/**
 * The top-holders strip on a token page (components/tape/TileStrip.tsx), as pure data.
 *
 * A holder's share is its balance over the token's total supply, in integer maths: the table's "% of
 * Supply" column and the strip read the SAME `bp` (basis points, floored) from here, so a tile and its
 * row cannot disagree. Widths use parts per million, because a 0.004% holder is 0 bp but still a tile.
 * This module is imported by a client component, so it takes no heavy imports (lib/format pulls ethers).
 */
import { clipText, type StripTile } from '@/lib/tape'

export interface HolderShares {
  /** Per holder: share of supply in basis points (1/100 of a percent), floored; null for an unreadable balance. */
  bp: (number | null)[]
  /** Per holder: share in parts per million, floored (the tile's width). 0 for an unreadable balance. */
  ppm: number[]
  /** What the listed holders do not hold, in ppm; 0 when they hold the whole supply or more. */
  restPpm: number
  /** What the listed holders hold together, in basis points. */
  topBp: number
}

function toBig(v: string | null | undefined): bigint | null {
  if (v == null || !/^\d+$/.test(v)) return null
  return BigInt(v)
}

/** Shares of `totalSupply` (raw base units), or null when the supply is not a positive integer. */
export function holderShares(balances: readonly string[], totalSupply: string | null | undefined): HolderShares | null {
  const supply = toBig(totalSupply)
  if (supply === null || supply === 0n) return null
  const bals = balances.map(toBig)
  const held = bals.reduce<bigint>((s, b) => s + (b ?? 0n), 0n)
  return {
    bp: bals.map(b => (b === null ? null : Number((b * 10_000n) / supply))),
    ppm: bals.map(b => (b === null ? 0 : Number((b * 1_000_000n) / supply))),
    restPpm: held >= supply ? 0 : Number(((supply - held) * 1_000_000n) / supply),
    topBp: Number((held * 10_000n) / supply),
  }
}

/** "12.34%" from basis points, or "—" when there is no share. The table's long-standing format. */
export function bpText(bp: number | null): string {
  return bp === null ? '—' : `${(bp / 100).toFixed(2)}%`
}

export interface HolderRow {
  addr: string
  /** What the row calls the address (its label or the short form). */
  name: string
  /** The balance as the table prints it, in whole tokens. */
  amount: string
}

/** One tile per holder, in rank order, then an "others" tile for the rest of the supply. */
export function holderStripTiles(rows: readonly HolderRow[], shares: HolderShares, symbol: string): StripTile[] {
  const tiles: StripTile[] = rows.map((r, i) => {
    const href = `/address/${r.addr.toLowerCase()}`
    return {
      id: href,
      href,
      w: Math.max(1, shares.ppm[i] ?? 0),
      f: 100,
      name: `Holder ${i + 1}: ${r.name}`,
      // Two lines at most on a phone: a label and a symbol are anyone's to choose, so they are clipped here.
      read: `#${i + 1} ${clipText(r.name, 20)} · ${bpText(shares.bp[i] ?? null)} of supply · ${r.amount} ${clipText(symbol, 8)}`,
    }
  })
  if (shares.restPpm > 0) {
    tiles.push({
      id: 'rest',
      w: shares.restPpm,
      f: 0,
      name: 'All other holders',
      read: `Everyone else · ${bpText(Math.floor(shares.restPpm / 100))} of supply`,
      rest: true,
    })
  }
  return tiles
}

export type HoldersSource = 'moralis' | 'local'

/** The measure, said exactly. Both fit the legend's two lines on a phone (the estimate swaps for the live holders over it). */
export function holdersLegend(source: HoldersSource): string {
  return `width = share of supply · others = the rest · ${source === 'moralis' ? 'real balances' : 'estimated from transfers'}`
}

/** The strip's text alternative: what the tiles say, for a screen reader (the table below has every row). */
export function holdersSummary(count: number, shares: HolderShares, source: HoldersSource): string {
  const largest = bpText(shares.bp[0] ?? null)
  const kind = source === 'moralis'
    ? 'Real on-chain balances.'
    : 'Estimated from the net flow of recent transfers, not real balances.'
  return `The top ${count} holders hold ${(shares.topBp / 100).toFixed(1)}% of supply; the largest holds ${largest}. ${kind}`
}
