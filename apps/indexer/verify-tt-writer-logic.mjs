/**
 * Standalone logic verification for the async token_transfers writer (Part A) and
 * the partition-prune retention boundary (Part B). Pure JS — no TS/esbuild/DB — so
 * it runs even with the broken local toolchain:  node verify-tt-writer-logic.mjs
 *
 * It REPLICATES the exact algorithms from block-processor.ts / retention-cleanup.ts
 * and asserts their invariants. This is design/logic verification (mirrors the prior
 * sessions' standalone-script approach); true behavioral verification happens via the
 * profiler + crash-smoke on the deployed BNB indexer.
 */
let pass = 0, fail = 0
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++ } else { fail++; console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`) }
}
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.error(`  ✗ ${msg}`) } }

// ─────────────────────────────────────────────────────────────────────
// A. Watermark contiguous-prefix advance (block-processor runTransferWriter)
// ─────────────────────────────────────────────────────────────────────
function makeWatermark(seed) {
  let durableBlock = seed
  const written = new Set()
  return {
    W: () => durableBlock,
    aheadSize: () => written.size,
    // fold a set of just-written block numbers, advance W through the contiguous prefix
    fold(blockNums) {
      for (const n of blockNums) if (n > durableBlock) written.add(n)
      while (written.delete(durableBlock + 1)) durableBlock++
    },
    // setDurableFloor: jump forward, drop covered ahead-blocks
    floor(block) {
      if (block <= durableBlock) return
      durableBlock = block
      for (const n of written) if (n <= durableBlock) written.delete(n)
    },
  }
}

console.log('A. Watermark contiguous-prefix advance')
{
  const w = makeWatermark(100)
  w.fold([101, 102, 103]); eq(w.W(), 103, 'A1 in-order [101,102,103] → W=103')
}
{
  const w = makeWatermark(100)
  w.fold([103, 101]); eq(w.W(), 101, 'A2 gap: [103,101] (102 missing) → W=101')
  ok(w.aheadSize() === 1, 'A2 103 held ahead of W')
  w.fold([102]); eq(w.W(), 103, 'A3 fill gap [102] → W=103')
  ok(w.aheadSize() === 0, 'A3 ahead set drained')
}
{
  const w = makeWatermark(100)
  w.fold([105, 104, 101, 103, 102]); eq(w.W(), 105, 'A4 fully out-of-order → W=105')
}
{
  const w = makeWatermark(100)
  w.fold([101]); w.fold([101]) // duplicate/late write at/below W must not move or corrupt W
  eq(w.W(), 101, 'A5 duplicate write ≤W keeps W=101'); ok(w.aheadSize() === 0, 'A5 no phantom ahead-block')
}
{
  const w = makeWatermark(100)
  w.fold([105, 106]) // 105,106 held (102..104 missing)
  ok(w.W() === 100 && w.aheadSize() === 2, 'A6a stuck at 100 with 2 ahead')
  w.floor(110) // MAX_LAG skip jumps the floor
  eq(w.W(), 110, 'A6b setDurableFloor(110) → W=110'); ok(w.aheadSize() === 0, 'A6b covered ahead-blocks dropped')
  w.fold([111]); eq(w.W(), 111, 'A6c resumes from new floor → W=111')
  w.floor(50); eq(w.W(), 111, 'A6d floor below W is a no-op')
}

// ─────────────────────────────────────────────────────────────────────
// B. DELETE+INSERT-per-range idempotency (writeTransferBlocks)
//    Store keyed by natural identity (tx_hash, log_index); block scoping via DELETE.
// ─────────────────────────────────────────────────────────────────────
function makeStore() {
  const rows = new Map() // key -> {block, tx, log}
  const key = (r) => `${r.tx}|${r.log}`
  return {
    size: () => rows.size,
    countForBlock: (b) => [...rows.values()].filter(r => r.block === b).length,
    // mirror writeTransferBlocks(blockNums, rows): DELETE target blocks, then INSERT
    write(blockNums, batch) {
      const targets = new Set(blockNums)
      for (const [k, r] of rows) if (targets.has(r.block)) rows.delete(k)
      for (const r of batch) rows.set(key(r), r)
    },
  }
}
const R = (block, tx, log) => ({ block, tx, log })

console.log('B. DELETE+INSERT-per-range idempotency')
{
  const s = makeStore()
  const b50 = [R(50, '0xa', 0), R(50, '0xb', 1)]
  s.write([50], b50); eq(s.size(), 2, 'B1 first write block 50 → 2 rows')
  s.write([50], b50); eq(s.size(), 2, 'B1 replay block 50 → still 2 (no dupes)')
}
{
  const s = makeStore()
  s.write([50, 51], [R(50, '0xa', 0), R(51, '0xc', 0)])
  s.write([50, 51], [R(50, '0xa', 0), R(51, '0xc', 0)]) // crash replay
  eq(s.size(), 2, 'B2 replay [50,51] → 2 rows, idempotent')
}
{
  const s = makeStore()
  s.write([50], [R(50, '0xa', 0)])
  s.write([50, 51], [R(50, '0xa', 0), R(51, '0xb', 0)]) // overlapping coalesced drain
  eq(s.size(), 2, 'B3 overlapping drain → 2 rows, no dup of block 50')
  ok(s.countForBlock(50) === 1 && s.countForBlock(51) === 1, 'B3 one row per block')
}
{
  const s = makeStore()
  s.write([50], [R(50, '0xa', 0), R(50, '0xb', 1), R(50, '0xc', 2)]) // 3 rows
  s.write([50], [R(50, '0xa', 0)]) // re-decoded with fewer rows (e.g. reorg)
  eq(s.countForBlock(50), 1, 'B4 re-decode with fewer rows clears stale rows (DELETE-first)')
}
{
  // Non-contiguous drain must NOT wipe an already-written neighbour.
  const s = makeStore()
  s.write([104], [R(104, '0xz', 0)])               // neighbour written earlier
  s.write([103, 105], [R(103, '0xp', 0), R(105, '0xq', 0)]) // drain skips 104
  ok(s.countForBlock(104) === 1, 'B5 IN-list delete spares untargeted block 104')
  eq(s.size(), 3, 'B5 total 3 rows (103,104,105)')
}

// ─────────────────────────────────────────────────────────────────────
// C. Backpressure depth accounting (enqueueTransferWrite counters)
// ─────────────────────────────────────────────────────────────────────
function makeQueue(highWater) {
  let pending = new Map(), rows = 0
  return {
    rows: () => rows, blocks: () => pending.size,
    parked: () => rows > highWater,
    enqueue(b, n) { const prev = pending.get(b); if (prev !== undefined) rows -= prev; pending.set(b, n); rows += n },
    drainAll() { pending = new Map(); rows = 0 },
  }
}

console.log('C. Backpressure depth accounting')
{
  const q = makeQueue(50000)
  q.enqueue(1, 100); q.enqueue(2, 100); q.enqueue(3, 100)
  eq(q.rows(), 300, 'C1 three blocks of 100 → 300 rows'); eq(q.blocks(), 3, 'C1 3 blocks pending')
}
{
  const q = makeQueue(50000)
  q.enqueue(1, 100); q.enqueue(1, 50) // re-decode same block: overwrite, not add
  eq(q.rows(), 50, 'C2 re-enqueue overwrites prior count (no double-count)')
  eq(q.blocks(), 1, 'C2 still one pending block')
}
{
  const q = makeQueue(1000)
  ok(!q.parked(), 'C3 below high-water → not parked')
  q.enqueue(1, 1500); ok(q.parked(), 'C3 above high-water → parked (backpressure on)')
  q.drainAll(); ok(!q.parked() && q.rows() === 0, 'C3 after drain → released')
}

// ─────────────────────────────────────────────────────────────────────
// D. Retention partition selection (pruneTokenTransfersPartitioned)
// ─────────────────────────────────────────────────────────────────────
function classifyPartitions(parts, cutoff) {
  const drop = [], boundary = [], keep = []
  for (const p of parts) {
    if (p.hi <= cutoff) drop.push(p.name)
    else if (p.lo < cutoff && cutoff < p.hi) boundary.push(p.name)
    else keep.push(p.name)
  }
  return { drop, boundary, keep }
}

console.log('D. Retention partition classification')
{
  const parts = [
    { name: 'token_transfers_legacy', lo: 0, hi: 1000 },
    { name: 'token_transfers_p_1000', lo: 1000, hi: 2000 },
    { name: 'token_transfers_p_2000', lo: 2000, hi: 3000 },
    { name: 'token_transfers_p_3000', lo: 3000, hi: 4000 },
  ]
  const c = classifyPartitions(parts, 2500)
  eq(c.drop, ['token_transfers_legacy', 'token_transfers_p_1000'], 'D1 fully-below partitions dropped')
  eq(c.boundary, ['token_transfers_p_2000'], 'D1 straddling partition gets bounded DELETE')
  eq(c.keep, ['token_transfers_p_3000'], 'D1 future partition kept')
}
{
  // cutoff exactly on a boundary: hi == cutoff means fully below → drop
  const parts = [{ name: 'token_transfers_p_1000', lo: 1000, hi: 2000 }]
  const c = classifyPartitions(parts, 2000)
  eq(c.drop, ['token_transfers_p_1000'], 'D2 hi==cutoff → dropped (rows are block<cutoff)')
  ok(c.boundary.length === 0, 'D2 no boundary work when cutoff==hi')
}

// ─────────────────────────────────────────────────────────────────────
// E. Partition name parsing (listTokenTransferPartitions regex)
// ─────────────────────────────────────────────────────────────────────
function parseBound(bound) {
  const m = String(bound).match(/FROM \('?(\d+)'?\) TO \('?(\d+)'?\)/)
  return m ? { lo: Number(m[1]), hi: Number(m[2]) } : null
}
console.log('E. Partition bound parsing')
eq(parseBound("FOR VALUES FROM ('0') TO ('192000')"), { lo: 0, hi: 192000 }, 'E1 quoted bigint bounds')
eq(parseBound('FOR VALUES FROM (1000) TO (2000)'), { lo: 1000, hi: 2000 }, 'E2 unquoted bounds')
ok(parseBound('DEFAULT') === null, 'E3 DEFAULT partition skipped')

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
