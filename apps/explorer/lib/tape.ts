/** [blockNumber, unixSeconds, txCount, gasPct]: compact so the page can hand ~100 of them to the client. */
export type TapeTuple = [number, number, number, number]
/** A block as the tape draws it: `seconds` is the interval it took (its tile width), `gas` is 0-100. */
export interface TapeBlock { n: number; seconds: number; txs: number; gas: number }

/**
 * Give each block the interval it took: (previous block's time, own time]. Timestamps are whole
 * seconds, and BNB fits several blocks into one, so k blocks stamped `s` after a previous distinct
 * second `p` split (p, s] evenly, end to end. The oldest second has no predecessor and only anchors.
 * Accepts tuples in any order; returns the displayed blocks oldest first.
 */
export function spreadSeconds(tuples: TapeTuple[]): TapeBlock[] {
  const asc = [...tuples].sort((a, b) => a[0] - b[0])
  const out: TapeBlock[] = []
  let i = 0
  let prev: number | null = null
  while (i < asc.length) {
    const s = asc[i][1]
    let j = i
    while (j < asc.length && asc[j][1] === s) j++
    if (prev !== null) {
      const k = j - i
      const step = (s - prev) / k
      for (let m = 0; m < k; m++) {
        const [n, , txs, gas] = asc[i + m]
        out.push({ n, seconds: step, txs, gas })
      }
    }
    prev = s
    i = j
  }
  return out
}

/** Mean tile interval in seconds (0 for no blocks): the width of a "ghost" tile that pads the tape's left edge. */
export function meanSeconds(blocks: TapeBlock[]): number {
  if (!blocks.length) return 0
  return blocks.reduce((sum, b) => sum + b.seconds, 0) / blocks.length
}

/**
 * How many blocks before and after a block to fetch for its page's tape: ~18s of chain time to the
 * left (older) and ~3.6s to the right (newer), so the highlighted tile sits near the right end and
 * stays on screen. BNB (0.45s) gives 40 and 8; ETH (12s) gives 3 and 1, since one ETH tile is
 * already ~400px wide.
 */
export function tapeWindow(blockTime: number): { before: number; after: number } {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
  return {
    before: clamp(Math.round(18 / blockTime), 3, 40),
    after: clamp(Math.round(3.6 / blockTime), 1, 8),
  }
}

/**
 * How many of the newest blocks a "latest blocks" tape fetches: ~32s of chain time, which fills the
 * content column (1248px at 34px/s is ~37s, and its left ~120px sits under a fade). BNB (0.45s)
 * gives 72, ETH (12s) gives 7 (the tables' minimum); never more than 100.
 */
export function latestTapeCount(blockTime: number): number {
  return Math.min(100, Math.max(7, Math.ceil(32 / blockTime)))
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
