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
import type { StripTile } from '@/lib/tape'

export interface ProducerInput {
  address: string
  name: string
  /** Voting power in wei (18 decimals); null = unknown (lib/validator-display.ts: powerUnknown). */
  power: bigint | null
}

export interface ProducerStrip {
  tiles: StripTile[]
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
  const max = produced.reduce((m, p) => (p.v.power !== null && p.v.power > m ? p.v.power : m), 0n)
  const fillKnown = max > 0n

  const tiles = produced.map(({ v, n }): StripTile => {
    const href = `/address/${v.address.toLowerCase()}`
    const share = `${formatShare((n / windowBlocks) * 100)}%`
    const power = v.power === null ? 'voting power unknown' : `voting power ${formatNumber(v.power / E18)} ${currency}`
    return {
      id: href,
      href,
      w: n,
      f: !fillKnown ? 100 : v.power === null ? 0 : Number((v.power * 100n + max / 2n) / max),
      name: v.name,
      read: `${v.name} · ${blocksText(n)} · ${share} of the ${formatNumber(windowBlocks)} in the window · ${power}`,
    }
  })
  const best = produced.reduce((b, p) => (p.n > b.n ? p : b))
  return {
    tiles,
    producing: produced.length,
    total: vals.length,
    windowBlocks,
    unlisted: windowBlocks - listed,
    top: { name: best.v.name, blocks: best.n },
    fillKnown,
  }
}

/** The measure, said exactly; two lines at most on a phone (components/tape/legend-lines.ts). */
export function producerLegend(fillKnown: boolean): string {
  return fillKnown
    ? 'width = blocks produced, last 24h · fill = voting power vs the largest'
    : 'width = blocks produced, last 24h · voting power unknown right now'
}

/** The strip's text alternative (the table beside it has every validator). */
export function producerSummary(s: ProducerStrip): string {
  return `${s.producing} of ${s.total} validators produced blocks in the last 24 hours (${formatNumber(s.windowBlocks)} blocks counted); `
    + `the most was ${s.top.name} with ${formatNumber(s.top.blocks)}. `
    + (s.unlisted > 0 ? `${formatNumber(s.unlisted)} of the blocks came from addresses that are not in this list. ` : '')
    + (s.fillKnown
      ? 'Each tile is a validator in table order: width is its blocks, fill is its voting power against the largest shown.'
      : 'Each tile is a validator in table order: width is its blocks. Voting power is unknown right now.')
}
