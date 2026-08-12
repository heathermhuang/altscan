import assert from 'node:assert';
import { parseHealth, buildChainsPayload } from '../src/lib/chains.ts';

let passed = 0;
function t(name: string, fn: () => void) { fn(); passed++; console.log('ok -', name); }

// parseHealth: extracts block + online from a good health body
t('parseHealth: ok body → online with block', () => {
  const r = parseHealth({ status: 'ok', latestBlock: 123, lagSeconds: 4 });
  assert.deepEqual(r, { block: 123, online: true });
});

// parseHealth: null block → offline
t('parseHealth: null latestBlock → offline', () => {
  const r = parseHealth({ status: 'ok', latestBlock: null, lagSeconds: null });
  assert.deepEqual(r, { block: null, online: false });
});

// A live-but-degraded explorer is still ONLINE. /api/health degrades on index
// completeness gaps (and on memory pressure), and treating that as offline would
// have flipped bnbscan.com to "offline" on the marketing site the first time a
// block range was abandoned — while the explorer was up and serving normally.
t('parseHealth: degraded body → still online', () => {
  const r = parseHealth({ status: 'degraded', latestBlock: 456, lagSeconds: 3 });
  assert.deepEqual(r, { block: 456, online: true });
});

// Degraded still requires a usable block — degraded + no block is offline.
t('parseHealth: degraded with null block → offline', () => {
  const r = parseHealth({ status: 'degraded', latestBlock: null, lagSeconds: null });
  assert.deepEqual(r, { block: null, online: false });
});

// Anything that is not a recognised serving state stays offline.
t('parseHealth: error status → offline', () => {
  const r = parseHealth({ status: 'error', latestBlock: 789, lagSeconds: 1 });
  assert.deepEqual(r, { block: 789, online: false });
});

// parseHealth: undefined/garbage → offline, no throw
t('parseHealth: garbage → offline', () => {
  const r = parseHealth(undefined);
  assert.deepEqual(r, { block: null, online: false });
});

// buildChainsPayload: maps id→parsed, includes ts
t('buildChainsPayload: shapes per-id result', () => {
  const out = buildChainsPayload([
    { id: 'bnb', body: { status: 'ok', latestBlock: 44128902, lagSeconds: 3 } },
    { id: 'eth', body: null },
  ], 1700000000000);
  assert.deepEqual(out, {
    bnb: { block: 44128902, online: true },
    eth: { block: null, online: false },
    ts: 1700000000000,
  });
});

console.log(`\n${passed} passed`);
