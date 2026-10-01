import assert from 'node:assert';
import { gasPct, parseBlocks, buildChainsPayload } from '../src/lib/chains.ts';

let passed = 0;
function t(name: string, fn: () => void) { fn(); passed++; console.log('ok -', name); }

// A trimmed /api/v1/blocks row as the explorer serializes it (bigints → strings, Date → ISO).
const row = (number: number, iso: string, txCount: number, gasUsed: string, gasLimit = '1000') => ({
  number, hash: `0xhash${number}`, parentHash: '0xparent', timestamp: iso, miner: `0xminer${number}`,
  gasUsed, gasLimit, baseFeePerGas: '7', txCount, size: 100,
});

// gasPct: integer percent from bigint strings, never NaN
t('gasPct: rounds down to an integer percent', () => {
  assert.equal(gasPct('549', '1000'), 54);
});
t('gasPct: limit 0 → 0, not Infinity', () => {
  assert.equal(gasPct('5', '0'), 0);
});
t('gasPct: above the limit caps at 100', () => {
  assert.equal(gasPct('2000', '1000'), 100);
});
t('gasPct: values beyond 2^53 stay exact', () => {
  assert.equal(gasPct('45000000000000000000', '60000000000000000000'), 75);
});
t('gasPct: unparseable → null', () => {
  assert.equal(gasPct('1.5', '10'), null);
  assert.equal(gasPct(undefined, '10'), null);
});

// parseBlocks: newest-first tuples + the newest block's detail
t('parseBlocks: maps rows to [number, unixSeconds, txCount, gasPct], newest first', () => {
  const r = parseBlocks({ blocks: [
    row(100, '2026-10-01T12:00:00.000Z', 3, '500'),
    row(101, '2026-10-01T12:00:12.000Z', 7, '250'),
  ], total: 2, page: 1, limit: 2 });
  assert.equal(r.online, true);
  assert.equal(r.block, 101);
  assert.deepEqual(r.blocks, [[101, 1790856012, 7, 25], [100, 1790856000, 3, 50]]);
  assert.deepEqual(r.latest, {
    number: 101, hash: '0xhash101', miner: '0xminer101', timestamp: 1790856012, txCount: 7,
    gasUsed: '250', gasLimit: '1000', baseFeePerGas: '7',
  });
});
t('parseBlocks: drops malformed rows instead of coercing them', () => {
  const r = parseBlocks({ blocks: [
    row(100, '2026-10-01T12:00:00.000Z', 3, '500'),
    row(101, 'not a date', 3, '500'),
    { ...row(102, '2026-10-01T12:00:12.000Z', 3, '500'), number: '102' },
    row(103, '2026-10-01T12:00:24.000Z', -1, '500'),
    row(104, '2026-10-01T12:00:36.000Z', 3, 'abc'),
  ] });
  assert.deepEqual(r.blocks?.map((b) => b[0]), [100]);
});
t('parseBlocks: an empty list is offline (a bad upstream, not an idle chain)', () => {
  assert.deepEqual(parseBlocks({ blocks: [] }), { block: null, online: false });
});
t('parseBlocks: garbage, null and error bodies → offline, no throw', () => {
  for (const body of [undefined, null, 'x', { error: 'Rate limit exceeded' }, { blocks: 'nope' }]) {
    assert.deepEqual(parseBlocks(body), { block: null, online: false });
  }
});
t('parseBlocks: a null baseFeePerGas survives (pre-London style rows)', () => {
  const r = parseBlocks({ blocks: [{ ...row(5, '2026-10-01T12:00:00.000Z', 1, '1'), baseFeePerGas: null }] });
  assert.equal(r.latest?.baseFeePerGas, null);
});

// buildChainsPayload: keeps the documented { ts, <id>: { block, online } } contract
t('buildChainsPayload: shapes per-id result and keeps ts', () => {
  const out = buildChainsPayload([
    { id: 'bnb', body: { blocks: [row(44128902, '2026-10-01T12:00:00.000Z', 9, '100')] } },
    { id: 'eth', body: null },
  ], 1700000000000);
  assert.equal(out.ts, 1700000000000);
  assert.deepEqual(out.eth, { block: null, online: false });
  const bnb = out.bnb as { block: number; online: boolean; blocks: unknown[] };
  assert.equal(bnb.block, 44128902);
  assert.equal(bnb.online, true);
  assert.equal(bnb.blocks.length, 1);
});

console.log(`\n${passed} passed`);
