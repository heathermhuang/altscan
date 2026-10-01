import type { BlockTuple } from './chains';

/** The tape plays this many seconds behind the newest indexed block, so every tile already exists. */
export const DELAY_S = 12;
/** Newest indexed block older than this → the indexer is catching up. */
export const STALL_S = 90;
/** Jump the playhead forward (never back) once the target runs this far ahead of it. */
export const REANCHOR_S = 30;

export interface TapeBlock { n: number; t0: number; t1: number; tx: number; g: number }
export type ChainStatus = 'loading' | 'live' | 'stalled' | 'offline';
export interface Anchor { newestT: number; wall: number }

/**
 * Give each block the interval it took: (previous block's time, own time]. Timestamps are whole
 * seconds, and BNB fits several blocks into one, so k blocks stamped `s` after a previous distinct
 * second `p` split (p, s] evenly, end to end. The oldest second has no predecessor and only anchors.
 */
export function spreadSeconds(tuples: BlockTuple[]): TapeBlock[] {
  const asc = [...tuples].sort((a, b) => a[0] - b[0]);
  const out: TapeBlock[] = [];
  let i = 0;
  let prev: number | null = null;
  while (i < asc.length) {
    const s = asc[i][1];
    let j = i;
    while (j < asc.length && asc[j][1] === s) j++;
    if (prev !== null) {
      const k = j - i;
      const step = (s - prev) / k;
      for (let m = 0; m < k; m++) {
        const [n, , tx, g] = asc[i + m];
        out.push({ n, t0: prev + m * step, t1: prev + (m + 1) * step, tx, g });
      }
    }
    prev = s;
    i = j;
  }
  return out;
}

/** Blocks per minute measured from the oldest and newest block received. */
export function ratePerMin(tuples: BlockTuple[]): number | null {
  if (tuples.length < 2) return null;
  let lo = tuples[0], hi = tuples[0];
  for (const b of tuples) {
    if (b[0] < lo[0]) lo = b;
    if (b[0] > hi[0]) hi = b;
  }
  const dt = hi[1] - lo[1];
  if (dt <= 0) return null;
  return ((hi[0] - lo[0]) / dt) * 60;
}

/** Union by block number (incoming wins), newest first, capped to the newest `max`. */
export function mergeBlocks(existing: BlockTuple[], incoming: BlockTuple[], max: number): BlockTuple[] {
  const byN = new Map<number, BlockTuple>();
  for (const b of existing) byN.set(b[0], b);
  for (const b of incoming) byN.set(b[0], b);
  return [...byN.values()].sort((a, b) => b[0] - a[0]).slice(0, max);
}

/** `online` is null until the first payload arrives. */
export function classify(online: boolean | null, newestT: number | null, now: number): ChainStatus {
  if (online === null) return 'loading';
  if (!online || newestT === null) return 'offline';
  return now - newestT > STALL_S ? 'stalled' : 'live';
}

export function playhead(anchor: Anchor, now: number): number {
  return anchor.newestT - DELAY_S + (now - anchor.wall);
}

/**
 * The playhead runs on the wall clock, so a hidden tab or a slow poll never desyncs it. It only
 * re-anchors when the target (newest − DELAY) gets more than REANCHOR_S ahead — an indexer burst
 * after a stall. It never moves back: during a stall it runs past the newest block and the tape drains.
 */
export function nextAnchor(anchor: Anchor | null, newestT: number, now: number): Anchor {
  if (!anchor) return { newestT, wall: now };
  return newestT - DELAY_S - playhead(anchor, now) > REANCHOR_S ? { newestT, wall: now } : anchor;
}

/** Blocks indexed since the page opened, summed over chains seen both then and now. */
export function sinceOpened(first: Record<string, number>, current: Record<string, number>): number {
  let sum = 0;
  for (const id of Object.keys(first)) {
    if (id in current) sum += Math.max(0, current[id] - first[id]);
  }
  return sum;
}
