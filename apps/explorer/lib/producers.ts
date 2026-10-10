/**
 * The /validators producers strip as pure data: one tile per validator that produced a block in the
 * page's "Blocks (24h)" window, width = blocks produced, fill = voting power against the largest shown.
 *
 * Nothing here is queried: `counts` is the page's own per-miner GROUP BY (lib/validator-blocks.ts), so
 * the strip and the table's Blocks column are one reading and cannot disagree. A null `counts` (the
 * query failed) draws no strip: an unknown is not a strip of zeros. Fill is dropped, and the legend
 * says so, when no shown validator has a known voting power (the ValidatorSet fallback writes 0).
 */
import { formatNumber, formatShare } from '@/lib/format'
import { clipText } from '@/lib/clip-text'
import type { StripTile } from '@/lib/tape'

export interface ProducerInput {
  address: string
  name: string
  /** Voting power in wei (18 decimals); null = unknown (lib/validator-display.ts: powerUnknown). */
  power: bigint | null
}

/**
 * How many validators get a tile of their own. Every tile ships twice (the HTML and the page's flight payload), and
 * /validators sits just under the first network flight (~14.6 KB with headers), so past this the rest of the
 * producers are ONE labelled tile; the table beside the strip still lists every validator.
 */
export const PRODUCER_TILES_MAX = 24

export interface ProducerStrip {
  tiles: StripTile[]
  /** Producers drawn together as the last, neutral tile (0 when every producer has its own). */
  merged: number
  /** Validators that produced at least one block in the window. */
  producing: number
  /** Validators listed. */
  total: number
  /** Every block in the window, whoever produced it. */
  windowBlocks: number
  /** Window blocks produced by an address that is not in the list. */
  unlisted: number
  /** The most prolific listed validator. */
  top: { name: string; blocks: number }
  /** Whether the fill is voting power (false: none is known, the tiles are solid). */
  fillKnown: boolean
}

const E18 = 10n ** 18n
const blocksText = (n: number) => `${formatNumber(n)} block${n === 1 ? '' : 's'}`

export function producerStrip(
  vals: readonly ProducerInput[],
  counts: ReadonlyMap<string, number> | null,
  currency: string,
): ProducerStrip | null {
  if (counts === null) return null
  const produced = vals
    .map(v => ({ v, n: counts.get(v.address.toLowerCase()) ?? 0 }))
    .filter(p => p.n > 0)
  if (produced.length === 0) return null

  const windowBlocks = [...counts.values()].reduce((s, n) => s + n, 0)
  const listed = vals.reduce((s, v) => s + (counts.get(v.address.toLowerCase()) ?? 0), 0)
  const shown = produced.slice(0, PRODUCER_TILES_MAX)
  const merged = produced.slice(PRODUCER_TILES_MAX)
  const share = (n: number) => `${formatShare((n / windowBlocks) * 100)}%`
  // Scaled to the largest voting power DRAWN, so the biggest tile in view is always full.
  const max = shown.reduce((m, p) => (p.v.power !== null && p.v.power > m ? p.v.power : m), 0n)
  const fillKnown = max > 0n

  const tiles = shown.map(({ v, n }): StripTile => {
    const power = v.power === null ? 'power unknown' : `power ${formatNumber(v.power / E18)} ${currency}`
    return {
      href: `/address/${v.address.toLowerCase()}`,
      w: n,
      f: !fillKnown ? 100 : v.power === null ? 0 : Number((v.power * 100n + max / 2n) / max),
      // Two lines at most on a phone: a moniker is anyone's to choose, so it is clipped. The strip says `name · read`.
      name: clipText(v.name, 20),
      read: `${blocksText(n)} (${share(n)}) · ${power}`,
    }
  })
  if (merged.length > 0) {
    const n = merged.reduce((s, p) => s + p.n, 0)
    tiles.push({ w: n, f: 0, name: `${merged.length} other validators`, read: `${blocksText(n)} (${share(n)})`, rest: true })
  }
  const best = produced.reduce((b, p) => (p.n > b.n ? p : b))
  return {
    tiles,
    merged: merged.length,
    producing: produced.length,
    total: vals.length,
    windowBlocks,
    unlisted: windowBlocks - listed,
    top: { name: best.v.name, blocks: best.n },
    fillKnown,
  }
}

/** The measure, said exactly; two lines at most on a phone (test-support/legend-lines.ts). */
export function producerLegend(fillKnown: boolean): string {
  return fillKnown
    ? 'width = blocks produced, 24h · fill = voting power vs the largest shown'
    : 'width = blocks produced, 24h · voting power unknown right now'
}

/**
 * The strip's text alternative (the table beside it has every validator). The head stat, the list's accessible name
 * and the legend already say what a tile is and how it is measured, so this carries only what they do not.
 */
export function producerSummary(s: ProducerStrip): string {
  return `Most blocks: ${s.top.name}, ${formatNumber(s.top.blocks)} of ${formatNumber(s.windowBlocks)} counted.`
    + (s.merged > 0 ? ` The last ${s.merged} are one tile.` : '')
    + (s.unlisted > 0 ? ` ${formatNumber(s.unlisted)} came from addresses that are not in this list.` : '')
}
