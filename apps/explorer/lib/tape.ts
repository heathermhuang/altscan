/** [blockNumber, unixSeconds, txCount, gasPct]: compact so the page can hand a few dozen of them to the client. */
export type TapeTuple = [number, number, number, number]
/** A block as the tape draws it: width = `txs` (its transaction count), fill = `gas` (0-100). */
export interface TapeBlock { n: number; txs: number; gas: number }

/** The blocks to draw, oldest first (= left to right), from tuples in any order. */
export function tapeBlocks(tuples: TapeTuple[]): TapeBlock[] {
  return [...tuples].sort((a, b) => a[0] - b[0]).map(([n, , txs, gas]) => ({ n, txs, gas }))
}

/**
 * How many blocks each tape draws. Fixed per surface and the same on both chains: a tile's width is
 * its transaction count, so the chain's block time (BNB 0.45s, ETH 12s) no longer sizes anything.
 * The tiles share the track, so the tape fills it at any width. 40 is the largest round count whose
 * tiles still average 6px on a 375px phone (343px track, 2px gaps: 6.6px; 50 would be 4.9px) and at
 * 1440px they average 29px. A block page looks further back than forward so the ringed tile sits
 * right of centre: 24 + itself + 6 = 31 tiles, 9px on a phone, 38px at 1440. Each tile is ~100 bytes
 * of markup and the homepage HTML must stay inside one TCP window (~14.6 KB gzipped, Lighthouse
 * mobile LCP), which is the other reason not to draw more.
 */
export const TAPE_LATEST = 40
export const TAPE_BEFORE = 24
export const TAPE_AFTER = 6
/** The gap between tiles (the `gap` in app/globals.css, ".tp-gap"). */
const TAPE_GAP_PX = 2
/** The smallest a tile gets (`min-width` in ".tp-gap"), and the ringed one (`min-width` of ".tp-row > .c"). */
const TAPE_FLOOR_PX = 2
const TAPE_RING_FLOOR_PX = 3
/**
 * The two widths the ringed label is placed for: the tape's content at a 375px viewport (the 16px page
 * gutters off each side, measured: 343) and at 1440px (max-w-7xl, 1280, less the gutters: 1248). Between
 * them the CSS picks one at the `sm` breakpoint.
 */
export const TAPE_TRACK_SM = 343
export const TAPE_TRACK_LG = 1248

/** The average tile width, in px, of `count` tiles sharing a track `trackPx` wide. */
export function avgTilePx(count: number, trackPx: number): number {
  return (trackPx - (count - 1) * TAPE_GAP_PX) / count
}

/**
 * A tile's flex-grow: its transaction count, at least 1 so an empty block keeps a (tiny) share and a
 * tape of empty blocks still fills the track. The CSS gives every tile a 2px minimum width on top, so
 * a block with few transactions never vanishes (app/globals.css, ".tp-gap").
 */
export function tapeWeight(txs: number): number {
  return Number.isFinite(txs) && txs > 1 ? Math.round(txs) : 1
}

/**
 * The tape's flexbox, modelled: where each tile's left edge lands and how wide it is on a track `trackPx`
 * wide. Every tile is `flex: var(--w) 1 0` with a `min-width` floor (`floorPx`, `ringFloorPx` for the
 * ringed one) and `gapPx` between them. As in the CSS algorithm: the free space (track less gaps) is shared
 * out by flex-grow, a tile that comes out under its floor is frozen at the floor, and what is left is
 * shared again among the rest, until none is under its floor. Grow factors that sum under 1 share out only
 * that fraction of the space; a zero factor stays at its floor. Floors that do not fit overflow the track.
 */
export function layoutTiles(
  weights: number[],
  trackPx: number,
  { gapPx, floorPx, ringIndex = -1, ringFloorPx = floorPx }: { gapPx: number; floorPx: number; ringIndex?: number; ringFloorPx?: number },
): { left: number; width: number }[] {
  const floor = weights.map((_, i) => (i === ringIndex ? ringFloorPx : floorPx))
  const grow = weights.map(w => (w > 0 && Number.isFinite(w) ? w : 0))
  const width: (number | null)[] = weights.map(() => null)   // null = still flexible
  for (;;) {
    const open = width.flatMap((w, i) => (w === null ? [i] : []))
    if (!open.length) break
    const space = trackPx - gapPx * (weights.length - 1) - width.reduce<number>((s, w) => s + (w ?? 0), 0)
    const total = open.reduce((s, i) => s + grow[i], 0)
    const target = (i: number) => (total > 0 ? (space * Math.min(1, total) * grow[i]) / total : 0)
    const under = open.filter(i => target(i) < floor[i])
    if (!under.length) { for (const i of open) width[i] = target(i); break }
    for (const i of under) width[i] = floor[i]
  }
  let left = 0
  return width.map(w => {
    const tile = { left, width: w ?? 0 }
    left += tile.width + gapPx
    return tile
  })
}

/**
 * Where tile `k`'s centre sits along a tape `trackPx` wide, as a fraction of it (0 = left end, 1 = right
 * end), from the flexbox model above (so the floors count: 24 one-transaction tiles before a ringed one
 * put it ~96px in, not at its 4% of the weight). The ringed tile's label is placed at this fraction of the
 * track and shifted left by the same fraction of its OWN width, which keeps the label inside the track at
 * both ends and over its tile in the middle (app/globals.css, ".bt-chip"). The middle for no such tile.
 */
export function chipFraction(weights: number[], k: number, trackPx: number): number {
  if (k < 0 || k >= weights.length || !(trackPx > 0)) return 0.5
  const tile = layoutTiles(weights, trackPx, { gapPx: TAPE_GAP_PX, floorPx: TAPE_FLOOR_PX, ringIndex: k, ringFloorPx: TAPE_RING_FLOOR_PX })[k]
  return Math.min(1, Math.max(0, (tile.left + tile.width / 2) / trackPx))
}

/** Blocks per minute measured from the oldest and newest block received. */
export function ratePerMin(tuples: TapeTuple[]): number | null {
  if (tuples.length < 2) return null
  let lo = tuples[0]
  let hi = tuples[0]
  for (const b of tuples) {
    if (b[0] < lo[0]) lo = b
    if (b[0] > hi[0]) hi = b
  }
  const dt = hi[1] - lo[1]
  if (dt <= 0) return null
  return ((hi[0] - lo[0]) / dt) * 60
}

/**
 * Tuples as one compact string for the client island: "n0,t0|dn,dt,txs,gas;…", offsets from the
 * newest block. Absolute block numbers and timestamps are ~19 high-entropy digits a block, and the
 * homepage's HTML has to stay inside one TCP window (Lighthouse mobile LCP).
 */
export function encodeTape(tuples: TapeTuple[]): string {
  if (!tuples.length) return ''
  const [n0, t0] = tuples.reduce((a, b) => (b[0] > a[0] ? b : a))
  return `${n0},${t0}|` + tuples.map(([n, t, txs, gas]) => `${n0 - n},${t0 - t},${txs},${gas}`).join(';')
}

export function decodeTape(s: string): TapeTuple[] {
  if (!s) return []
  const [head, rows] = s.split('|')
  const [n0, t0] = head.split(',').map(Number)
  return rows.split(';').map(r => {
    const [dn, dt, txs, gas] = r.split(',').map(Number)
    return [n0 - dn, t0 - dt, txs, gas]
  })
}

type Gas = bigint | string | number | null | undefined

/** A block row (or the cached/ISO form of one) as a tape tuple. */
export function toTapeTuple(b: {
  number: number
  timestamp: Date | string
  txCount: number
  gasUsed: Gas
  gasLimit: Gas
}): TapeTuple {
  return [b.number, Math.floor(new Date(b.timestamp).getTime() / 1000), b.txCount, gasPct(b.gasUsed, b.gasLimit)]
}

/** Gas used as a whole percent of the limit, 0-100; 0 when the limit is zero or a value is not an integer. */
export function gasPct(used: Gas, limit: Gas): number {
  try {
    const l = BigInt(limit ?? 0)
    if (l <= 0n) return 0
    return Math.min(100, Math.max(0, Number((BigInt(used ?? 0) * 100n) / l)))
  } catch {
    return 0
  }
}

/** One transaction of a block as the block strip draws it: `i` = tx_index, `gas` = gas used, `price` = wei per gas. */
export interface StripTx { i: number; gas: number; price: number; ok: boolean }

/**
 * Where a tx sits in its block's strip and what share of the strip's gas it used: `pos` is its
 * index in `txs` (tx_index order; found by tx_index, which can skip), `pct` its gas as a percent of
 * the strip's total, null when that total is 0. Null when the tx is not in the strip. The one place
 * the tx page and the strip both read "% of its block" from, so they cannot disagree. It returns the
 * number, not text: lib/format pulls ethers, and this module is imported by a client component.
 */
export function txShareOfBlock(txs: StripTx[], txIndex: number): { pos: number; pct: number | null } | null {
  const pos = txs.findIndex(t => t.i === txIndex)
  if (pos < 0) return null
  const used = txs.reduce((s, t) => s + t.gas, 0)
  return { pos, pct: used > 0 ? (txs[pos].gas / used) * 100 : null }
}

/** A strip tile's flex weight: gas used in thousands, at least 1 (a 21k transfer is 21; nothing is 0). */
export function stripWeight(gas: number): number {
  return Math.max(1, Math.round(gas / 1000))
}

/**
 * Fill percent per tx: its gas price on a log scale from the block's lowest to highest positive price,
 * mapped to 30-100 so a floor-price tx still shows a fill. A zero price (a system tx) is 0; a block
 * whose positive prices are all equal fills them all.
 */
export function stripFills(prices: number[]): number[] {
  const pos = prices.filter(p => p > 0)
  if (!pos.length) return prices.map(() => 0)
  const lo = Math.log(Math.min(...pos))
  const hi = Math.log(Math.max(...pos))
  return prices.map(p => (p <= 0 ? 0 : hi === lo ? 100 : Math.round(30 + (70 * (Math.log(p) - lo)) / (hi - lo))))
}

/**
 * A tile of a TileStrip (components/tape/TileStrip.tsx): the strips on /gas, /validators, /dex and a
 * token's top holders. Plain data, so a page can hand it to the client component; the pure builders
 * (lib/gas-tape.ts, lib/producers.ts, lib/dex-size.ts, lib/holder-share.ts) make them.
 */
export interface StripTile {
  /**
   * Unique within the strip. Optional: a tile that links is known by its lowercased `href` (which is also what pairs it
   * with a table row), the remainder by its `name`. Set it only where hrefs can repeat (two swaps in one transaction).
   */
  id?: string
  /** The tile's width: its flex-grow. 0 = a fixed floor width (a hatched tile, which has no measurement). */
  w: number
  /** Fill height, 0-100. */
  f: number
  /** Where the tile goes. Omitted for a tile that is not one thing (the "others" remainder): not focusable. */
  href?: string
  /** What the tile is, short enough for the readout (anyone-chosen names are clipped by the builder). */
  name: string
  /** Its measure. The tile is announced and read out as `name · read`, so `read` must not repeat the name. */
  read: string
  /** Hatched: its width is not a measurement (a swap with no USD price). */
  hatch?: boolean
  /** The remainder tile: neutral colour, no link. */
  rest?: boolean
}
