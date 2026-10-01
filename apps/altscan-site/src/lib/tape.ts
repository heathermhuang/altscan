import type { BlockTuple } from './chains';

/** The tape plays this many seconds behind the newest indexed block, so every tile already exists. */
export const DELAY_S = 12;
/** Newest indexed block older than this → the indexer is catching up. */
export const STALL_S = 90;
/** Seconds between polls; the playhead aims to be on target by the next payload. */
export const POLL_S = 12;
/** Fastest replay, as a multiple of chain speed (a catching-up indexer can run ~15x). */
export const MAX_RATE = 20;
/** A target further ahead than this is jumped to rather than chased. */
export const JUMP_S = 60;

export interface TapeBlock { n: number; t0: number; t1: number; tx: number; g: number }
export type ChainStatus = 'loading' | 'live' | 'stalled' | 'offline';
/** Chain time p0 at wall time wall0, advancing `rate` chain-seconds per wall-second. */
export interface Playhead { p0: number; wall0: number; rate: number }

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

export function playheadAt(ph: Playhead, now: number): number {
  return ph.p0 + ph.rate * (now - ph.wall0);
}

/** Chain-seconds indexed per wall-second between two payloads; ~1 when live, ~15 catching up. */
export function indexRate(prev: { newestT: number; wall: number } | null, newestT: number, now: number): number | null {
  if (!prev || now <= prev.wall) return null;
  return Math.max(0, (newestT - prev.newestT) / (now - prev.wall));
}

/**
 * Steer the playhead toward (newest − DELAY_S) so it arrives by the next poll, moving at the speed
 * the indexer is actually adding blocks. Live, that is chain speed. Catching up, the tape replays
 * what was just indexed, faster. Stopped, it freezes. It never moves backwards, and a target more
 * than JUMP_S ahead is jumped to (a backlog cleared while the tab slept).
 */
export function retarget(ph: Playhead | null, newestT: number, idxRate: number | null, now: number): Playhead {
  const clamp = (r: number) => Math.min(MAX_RATE, Math.max(0, r));
  const target = newestT - DELAY_S;
  if (!ph) return { p0: target, wall0: now, rate: 1 };
  const cur = playheadAt(ph, now);
  // After a jump, move at the measured indexing speed, or a 15x catch-up would jump every poll.
  if (target - cur > JUMP_S) return { p0: target, wall0: now, rate: clamp(idxRate ?? 1) };
  return { p0: cur, wall0: now, rate: clamp((target + POLL_S * (idxRate ?? 1) - cur) / POLL_S) };
}

/** Compact lag for the tape header: 45s, 3m, 40h. */
export function lagLabel(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** Blocks indexed since the page opened, summed over chains seen both then and now. */
export function sinceOpened(first: Record<string, number>, current: Record<string, number>): number {
  let sum = 0;
  for (const id of Object.keys(first)) {
    if (id in current) sum += Math.max(0, current[id] - first[id]);
  }
  return sum;
}
