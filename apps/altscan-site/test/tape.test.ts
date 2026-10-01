import assert from 'node:assert';
import {
  spreadSeconds, ratePerMin, mergeBlocks, classify, playhead, nextAnchor, sinceOpened,
  DELAY_S, STALL_S, REANCHOR_S,
} from '../src/lib/tape.ts';
import type { BlockTuple } from '../src/lib/chains.ts';

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

// playhead / nextAnchor
t('playhead: starts DELAY behind the newest block and advances with the wall clock', () => {
  assert.equal(DELAY_S, 12);
  const a = { newestT: 1000, wall: 50 };
  assert.equal(playhead(a, 50), 988);
  assert.equal(playhead(a, 53.5), 991.5);
});
t('nextAnchor: first payload anchors', () => {
  assert.deepEqual(nextAnchor(null, 1000, 50), { newestT: 1000, wall: 50 });
});
t('nextAnchor: keeps the anchor while the target is within reach', () => {
  assert.equal(REANCHOR_S, 30);
  const a = { newestT: 1000, wall: 0 };
  // 12s later the newest is 1012 and the playhead is exactly on target.
  assert.equal(nextAnchor(a, 1012, 12), a);
  // indexer burst: target 29s ahead of the playhead → still smooth
  assert.equal(nextAnchor(a, 1041, 12), a);
});
t('nextAnchor: jumps forward when the target runs more than REANCHOR ahead', () => {
  const a = { newestT: 1000, wall: 0 };
  assert.deepEqual(nextAnchor(a, 1043, 12), { newestT: 1043, wall: 12 });
});
t('nextAnchor: never moves the playhead backwards during a stall', () => {
  const a = { newestT: 1000, wall: 0 };
  // newest stuck at 1000 for 100s: the playhead is ~88s past its target but is not pulled back
  assert.equal(nextAnchor(a, 1000, 100), a);
});

// sinceOpened
t('sinceOpened: sums growth across chains and ignores chains missing on either side', () => {
  assert.equal(sinceOpened({ bnb: 100, eth: 50 }, { bnb: 180, eth: 55 }), 85);
  assert.equal(sinceOpened({ bnb: 100 }, { bnb: 120, eth: 9 }), 20);
  assert.equal(sinceOpened({ bnb: 100 }, { bnb: 90 }), 0);
});

console.log(`\n${passed} passed`);
