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

type Gas = bigint | string | number | null | undefined

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
