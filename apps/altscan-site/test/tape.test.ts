import assert from 'node:assert';
import {
  spreadSeconds, ratePerMin, mergeBlocks, classify, retarget, playheadAt, indexRate, lagLabel, sinceOpened,
  DELAY_S, STALL_S, MAX_RATE, JUMP_S,
} from '../src/lib/tape.ts';
import type { BlockTuple } from '../src/lib/chains.ts';
import type { Playhead } from '../src/lib/tape.ts';

let passed = 0;
function t(name: string, fn: () => void) { fn(); passed++; console.log('ok -', name); }
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
const tup = (n: number, ts: number, tx = 1, g = 50): BlockTuple => [n, ts, tx, g];

// spreadSeconds: a block occupies (previous time, own time]
t('spreadSeconds: 12s blocks get 12s intervals; the oldest only anchors', () => {
  const out = spreadSeconds([tup(3, 124), tup(1, 100), tup(2, 112)]);
  assert.deepEqual(out.map((b) => [b.n, b.t0, b.t1]), [[2, 100, 112], [3, 112, 124]]);
});
t('spreadSeconds: blocks sharing a second split it evenly, end to end', () => {
  // 0.75s blocks stamped in whole seconds: 10, 11, 11, 12
  const out = spreadSeconds([tup(1, 10), tup(2, 11), tup(3, 11), tup(4, 12)]);
  assert.deepEqual(out.map((b) => b.n), [2, 3, 4]);
  close(out[0].t0, 10); close(out[0].t1, 10.5);
  close(out[1].t0, 10.5); close(out[1].t1, 11);
  close(out[2].t0, 11); close(out[2].t1, 12);
});
t('spreadSeconds: a gap of several seconds is shared by the blocks that follow it', () => {
  const out = spreadSeconds([tup(1, 10), tup(2, 13), tup(3, 13), tup(4, 13)]);
  assert.deepEqual(out.map((b) => [b.t0, b.t1]), [[10, 11], [11, 12], [12, 13]]);
});
t('spreadSeconds: the oldest second is an anchor even when shared', () => {
  const out = spreadSeconds([tup(1, 10), tup(2, 10), tup(3, 11)]);
  assert.deepEqual(out.map((b) => b.n), [3]);
});
t('spreadSeconds: one block or one shared second → nothing to draw', () => {
  assert.deepEqual(spreadSeconds([tup(1, 10)]), []);
  assert.deepEqual(spreadSeconds([tup(1, 10), tup(2, 10)]), []);
  assert.deepEqual(spreadSeconds([]), []);
});
t('spreadSeconds: carries txCount and gas through', () => {
  const [b] = spreadSeconds([tup(1, 0), tup(2, 12, 187, 54)]);
  assert.equal(b.tx, 187); assert.equal(b.g, 54);
});

// ratePerMin
t('ratePerMin: measured from first and last block', () => {
  assert.equal(ratePerMin([tup(100, 0), tup(180, 60)]), 80);
  assert.equal(ratePerMin([tup(10, 120), tup(0, 0)]), 5);
});
t('ratePerMin: under two blocks or no elapsed time → null', () => {
  assert.equal(ratePerMin([tup(1, 0)]), null);
  assert.equal(ratePerMin([tup(1, 5), tup(2, 5)]), null);
  assert.equal(ratePerMin([]), null);
});

// mergeBlocks
t('mergeBlocks: union by number, newest first, capped to the newest N', () => {
  const out = mergeBlocks([tup(3, 30), tup(2, 20)], [tup(4, 40), tup(3, 30), tup(1, 10)], 3);
  assert.deepEqual(out.map((b) => b[0]), [4, 3, 2]);
});
t('mergeBlocks: an incoming row replaces an existing one with the same number', () => {
  const out = mergeBlocks([tup(5, 50, 1, 10)], [tup(5, 50, 9, 90)], 10);
  assert.deepEqual(out, [tup(5, 50, 9, 90)]);
});

// classify
t('classify: no payload yet → loading', () => {
  assert.equal(classify(null, null, 1000), 'loading');
});
t('classify: online false → offline, even with old data kept', () => {
  assert.equal(classify(false, 990, 1000), 'offline');
});
t('classify: stalled only past the threshold', () => {
  assert.equal(STALL_S, 90);
  assert.equal(classify(true, 1000 - 89, 1000), 'live');
  assert.equal(classify(true, 1000 - 91, 1000), 'stalled');
});
t('classify: online without a block is offline', () => {
  assert.equal(classify(true, null, 1000), 'offline');
});

// playhead: follows the indexing speed, never moves back
const at = (ph: Playhead, now: number) => playheadAt(ph, now);
t('retarget: the first payload starts DELAY behind the newest block at chain speed', () => {
  assert.equal(DELAY_S, 12);
  assert.deepEqual(retarget(null, 1000, null, 50), { p0: 988, wall0: 50, rate: 1 });
});
t('retarget: live steady state keeps rate 1 and stays continuous', () => {
  const a = retarget(null, 1000, null, 0);
  const b = retarget(a, 1012, 1, 12);
  assert.equal(b.p0, at(a, 12));
  close(b.rate, 1);
});
t('retarget: an indexer catching up at 15x replays at ~15x', () => {
  const a = retarget(null, 1000, null, 0);
  const b = retarget(a, 1180, 15, 12);
  close(b.rate, 15);
});
t('retarget: a steady 15x catch-up holds speed and stops jumping after the first poll', () => {
  const a = retarget(null, 1000, null, 0);
  const b = retarget(a, 1180, 15, 12);       // first gap is beyond JUMP_S → jump
  const c = retarget(b, 1360, 15, 24);       // next poll lands exactly on target
  assert.equal(c.p0, at(b, 24));
  close(c.rate, 15);
});
t('retarget: speed is capped', () => {
  assert.equal(MAX_RATE, 20);
  const a = retarget(null, 1000, null, 0);
  assert.equal(retarget(a, 1400, 40, 12).rate, MAX_RATE);
});
t('retarget: a burst within JUMP_S is absorbed smoothly, not jumped', () => {
  assert.equal(JUMP_S, 60);
  const a = retarget(null, 1000, null, 0);
  const b = retarget(a, 1012 + 29, 1, 12);
  assert.equal(b.p0, at(a, 12));
  close(b.rate, 1 + 29 / 12);
});
t('retarget: a gap beyond JUMP_S jumps forward to the target', () => {
  const a = retarget(null, 1000, null, 0);
  assert.deepEqual(retarget(a, 1012 + 61, 1, 12), { p0: 1061, wall0: 12, rate: 1 });
});
t('retarget: a stopped indexer freezes the tape, never reverses it', () => {
  const a = retarget(null, 1000, null, 0);
  const b = retarget(a, 1000, 0, 12);      // newest unchanged; playhead 12s past target
  assert.equal(b.rate, 0);
  assert.equal(b.p0, at(a, 12));
  assert.equal(at(b, 60), b.p0);
});
t('retarget: a playhead that ran past the newest block is pulled back to it, not beyond', () => {
  // A 15x catch-up stalls: the extrapolated playhead (1000 + 15*12 = 1180) is past the newest block (1100).
  const ph = { p0: 1000, wall0: 0, rate: 15 };
  const b = retarget(ph, 1100, 0, 12);
  assert.equal(b.p0, 1100);
  assert.equal(b.rate, 0);
});
t('playheadAt with a horizon never passes the newest block between polls', () => {
  const ph = { p0: 1000, wall0: 0, rate: 15 };
  assert.equal(playheadAt(ph, 12, 1100), 1100);
  assert.equal(playheadAt(ph, 2, 1100), 1030);
});
t('indexRate: chain seconds per wall second between payloads', () => {
  assert.equal(indexRate(null, 1000, 5), null);
  assert.equal(indexRate({ newestT: 1000, wall: 0 }, 1180, 12), 15);
  assert.equal(indexRate({ newestT: 1000, wall: 12 }, 1010, 12), null);
});
t('lagLabel: seconds, minutes, hours', () => {
  assert.equal(lagLabel(45), '45s');
  assert.equal(lagLabel(150), '3m');
  assert.equal(lagLabel(145743), '40h');
});

// sinceOpened
t('sinceOpened: sums growth across chains and ignores chains missing on either side', () => {
  assert.equal(sinceOpened({ bnb: 100, eth: 50 }, { bnb: 180, eth: 55 }), 85);
  assert.equal(sinceOpened({ bnb: 100 }, { bnb: 120, eth: 9 }), 20);
  assert.equal(sinceOpened({ bnb: 100 }, { bnb: 90 }), 0);
});

console.log(`\n${passed} passed`);
