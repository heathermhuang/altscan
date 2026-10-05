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
