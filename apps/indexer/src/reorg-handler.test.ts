import { describe, expect, it } from 'vitest'
import {
  detectReorg, detectReorgPinned, resolveReorgDepth, UnresolvedForkError, UNWIND_ORDER, type ReorgDeps,
} from './reorg-handler'
import { schema } from '@altscan/db'
import { getTableColumns, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

/** Fake chain state: stored = what our DB has, rpc = canonical chain. */
function deps(stored: Record<number, string>, rpc: Record<number, { hash: string; parentHash: string }>): ReorgDeps {
  return {
    storedHash: async (n) => stored[n] ?? null,
    rpcBlock: async (n) => rpc[n] ?? null,
  }
}

describe('detectReorg', () => {
  const K = 5
  it('no stored parent (fresh DB / gap) → not a reorg', async () => {
    const d = deps({}, { 11: { hash: 'b11', parentHash: 'b10' } })
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: false })
  })
  it('boundary parent matches → not a reorg', async () => {
    const d = deps({ 10: 'b10' }, { 11: { hash: 'b11', parentHash: 'b10' } })
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: false })
  })
  it('boundary parent mismatch → walks back to the last agreeing block', async () => {
    const d = deps(
      { 8: 'b8', 9: 'x9', 10: 'x10' },
      { 8: { hash: 'b8', parentHash: 'b7' }, 9: { hash: 'b9', parentHash: 'b8' }, 10: { hash: 'b10', parentHash: 'b9' }, 11: { hash: 'b11', parentHash: 'b10' } },
    )
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: true, forkPoint: 8 })
  })
  it('tip mode: next block absent on RPC, tip hash mismatch → reorg', async () => {
    const d = deps(
      { 9: 'b9', 10: 'x10' },
      { 9: { hash: 'b9', parentHash: 'b8' }, 10: { hash: 'b10', parentHash: 'b9' } },
    )
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: true, forkPoint: 9 })
  })
  it('tip mode: next block absent, tip hash matches → not a reorg', async () => {
    const d = deps({ 10: 'b10' }, { 10: { hash: 'b10', parentHash: 'b9' } })
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: false })
  })
  it('no agreement within K → throws instead of treating the floor as a common ancestor', async () => {
    // One endpoint's view is not proof: deleting down to an unverified floor is how a
    // single bad provider response rewrote canonical history. detectReorgPinned decides
    // whether enough endpoints agree to roll back anyway.
    const stored: Record<number, string> = {}
    const rpc: Record<number, { hash: string; parentHash: string }> = {}
    for (let n = 0; n <= 10; n++) { stored[n] = `x${n}`; rpc[n] = { hash: `b${n}`, parentHash: `b${n - 1}` } }
    rpc[11] = { hash: 'b11', parentHash: 'b10' }
    const err = await detectReorg(deps(stored, rpc), 10, K).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnresolvedForkError)
    expect((err as UnresolvedForkError).floor).toBe(5)
  })
  it('missing stored rows inside the walk are skipped, not treated as agreement', async () => {
    const d = deps(
      { 7: 'b7', 9: 'x9', 10: 'x10' },  // 8 missing locally
      { 7: { hash: 'b7', parentHash: 'b6' }, 8: { hash: 'b8', parentHash: 'b7' }, 9: { hash: 'b9', parentHash: 'b8' }, 10: { hash: 'b10', parentHash: 'b9' }, 11: { hash: 'b11', parentHash: 'b10' } },
    )
    expect(await detectReorg(d, 10, K)).toEqual({ isReorg: true, forkPoint: 7 })
  })
})

describe('resolveReorgDepth', () => {
  it('uses the env override when valid, else the chain default', () => {
    expect(resolveReorgDepth(15, { REORG_DEPTH: '25' })).toBe(25)
    expect(resolveReorgDepth(15, {})).toBe(15)
    for (const v of ['0', '-3', 'abc', '']) expect(resolveReorgDepth(15, { REORG_DEPTH: v })).toBe(15)
  })
})

describe('UNWIND_ORDER guardrail — every block-scoped table is unwound, children first', () => {
  it('covers exactly the schema tables carrying a block-number column', () => {
    // Every exported table, not a hand-kept subset: a hand-kept list is how
    // internal_transactions was added without anyone unwinding it. A table that
    // must NOT be unwound has to be excluded here by name, with the reason.
    const NOT_INDEX_DERIVED = new Set([
      // Moralis history caches keyed by address, filled by the backfill worker
      // and never by processBlock — a reorg of our own index does not touch them.
      'backfillAddressTxs', 'backfillTokenTransfers',
    ])
    const blockScoped = new Set<string>()
    for (const [name, t] of Object.entries(schema)) {
      if (!is(t, PgTable) || NOT_INDEX_DERIVED.has(name)) continue
      const cols = Object.keys(getTableColumns(t))
      if (cols.includes('blockNumber') || name === 'blocks') blockScoped.add(name)
    }
    expect(new Set(UNWIND_ORDER)).toEqual(blockScoped)
  })
  it('deletes transactions before blocks, and blocks last (FK order)', () => {
    expect(UNWIND_ORDER.indexOf('transactions')).toBeLessThan(UNWIND_ORDER.indexOf('blocks'))
    expect(UNWIND_ORDER[UNWIND_ORDER.length - 1]).toBe('blocks')
    expect(UNWIND_ORDER).toContain('gasHistory')  // the delete the old dead code forgot
  })
})

/**
 * codex P1 on the tip/reorg failover change.
 *
 * Per-READ failover mixes chain views across endpoints. A current endpoint can
 * flag a mismatch at L+1, then a STALE endpoint returns the orphaned stored hash
 * at L, so findForkPoint() "agrees" at L, the unwind is a no-op, and — because
 * processBlock() never validates parent continuity against the stored chain —
 * workers go on to persist blocks from two different forks.
 *
 * The invariant: one reorg check reads from exactly one provider, or it is
 * abandoned and restarted whole on the next one.
 */
describe('detectReorgPinned', () => {
  type Fake = { name: string; hashes: Record<number, { hash: string; parentHash: string } | null> }

  const depsFor = (seen: string[]) => (p: Fake): ReorgDeps => ({
    async storedHash(n) {
      // Local chain: block N has hash `stored-N`.
      return `stored-${n}`
    },
    async rpcBlock(n) {
      seen.push(p.name)
      return p.hashes[n] ?? null
    },
  })

  it('reads every block of one check from a single provider', async () => {
    const seen: string[] = []
    // `current` disagrees at L+1, forcing the K-bounded walk. If the walk were
    // allowed to rotate, `stale` would answer some of those reads.
    const current: Fake = { name: 'current', hashes: {
      101: { hash: 'x-101', parentHash: 'FORKED' },
      100: { hash: 'x-100', parentHash: 'x-99' },
      99:  { hash: 'stored-99', parentHash: 'stored-98' },
    } }
    const stale: Fake = { name: 'stale', hashes: {
      101: { hash: 'y', parentHash: 'stored-100' },
      100: { hash: 'stored-100', parentHash: 'stored-99' },
    } }
    const res = await detectReorgPinned([current, stale], 0, depsFor(seen), 100, 15, 1000)
    expect(res).toEqual({ isReorg: true, forkPoint: 99 })
    expect(new Set(seen)).toEqual(new Set(['current']))
  })

  it('restarts the WHOLE check on the next provider — never resumes mid-walk', async () => {
    const seen: string[] = []
    const broken: Fake = { name: 'broken', hashes: {} }
    const good: Fake = { name: 'good', hashes: {
      101: { hash: 'z-101', parentHash: 'stored-100' },
    } }
    const deps = (p: Fake): ReorgDeps => ({
      async storedHash(n) { return `stored-${n}` },
      async rpcBlock(n) {
        seen.push(p.name)
        if (p.name === 'broken') throw new Error('endpoint down')
        return p.hashes[n] ?? null
      },
    })
    const res = await detectReorgPinned([broken, good], 0, deps, 100, 15, 1000)
    expect(res).toEqual({ isReorg: false })
    // 'broken' threw on its first read; 'good' then ran the check from scratch.
    expect(seen.filter(s => s === 'good').length).toBeGreaterThan(0)
    expect(seen.indexOf('good')).toBeGreaterThan(seen.lastIndexOf('broken'))
  })

  it('fails the whole check over when a provider hangs past the timeout', async () => {
    const hung: Fake = { name: 'hung', hashes: {} }
    const good: Fake = { name: 'good', hashes: {
      101: { hash: 'z', parentHash: 'stored-100' },
    } }
    const deps = (p: Fake): ReorgDeps => ({
      async storedHash(n) { return `stored-${n}` },
      async rpcBlock(n) {
        if (p.name === 'hung') return new Promise(() => {})
        return p.hashes[n] ?? null
      },
    })
    await expect(detectReorgPinned([hung, good], 0, deps, 100, 15, 30))
      .resolves.toEqual({ isReorg: false })
  })
})

describe('detectReorgPinned health kind', () => {
  // f068: reorg checks share nothing with tip reads' health, or a successful
  // getBlockNumber clears the reorg-failure streak of an endpoint that serves the
  // tip but not older headers.
  it("orders, records and clears health under 'reorg' — never 'read'", async () => {
    const calls: Array<[string, string]> = []
    const health = {
      order: (ps: readonly string[], _s: number, kind: string) => { calls.push(['order', kind]); return [...ps] },
      recordSuccess: (_p: string, kind: string) => { calls.push(['success', kind]) },
      recordFailure: (_p: string, kind: string) => { calls.push(['failure', kind]) },
      demoted: () => [],
    }
    const deps = (p: string): ReorgDeps => ({
      async storedHash(n) { return `stored-${n}` },
      async rpcBlock() {
        if (p === 'down') throw new Error('endpoint down')
        return { hash: 'z', parentHash: 'stored-100' }
      },
    })
    await expect(detectReorgPinned(['down', 'good'], 0, deps, 100, 15, 1000, undefined, health))
      .resolves.toEqual({ isReorg: false })
    expect(calls).toEqual([['order', 'reorg'], ['failure', 'reorg'], ['success', 'reorg']])
  })
})

/**
 * No stored hash agrees with an endpoint's chain anywhere within K. That is either a
 * reorg deeper than K or an endpoint serving a different chain, and one endpoint
 * cannot tell them apart. Rolling back to the floor deletes K blocks of history, so
 * it needs a second endpoint to say the same thing.
 */
describe('detectReorgPinned with no agreement within K', () => {
  const L = 100, K = 15
  // `wrong` disagrees with every stored hash (a different chain, or a bad response).
  const wrong = (n: number) => ({ hash: `w-${n}`, parentHash: `w-${n - 1}` })
  // `canon` matches storage up to 97, then forks: a real reorg of depth 3.
  const canon = (n: number) => n <= 97
    ? { hash: `stored-${n}`, parentHash: `stored-${n - 1}` }
    : { hash: `c-${n}`, parentHash: n === 98 ? 'stored-97' : `c-${n - 1}` }

  type Ep = { name: string; block: (n: number) => { hash: string; parentHash: string } | null }
  const deps = (p: Ep): ReorgDeps => ({
    async storedHash(n) { return `stored-${n}` },
    async rpcBlock(n) {
      if (p.name === 'down') throw new Error('endpoint down')
      return p.block(n)
    },
  })

  it('one endpoint on the wrong chain fails over to one that finds the real fork point', async () => {
    const res = await detectReorgPinned<Ep>([{ name: 'wrong', block: wrong }, { name: 'canon', block: canon }], 0, deps, L, K, 1000)
    expect(res).toEqual({ isReorg: true, forkPoint: 97 })
  })

  it('two endpoints that independently find no agreement roll back to the floor', async () => {
    const res = await detectReorgPinned<Ep>([{ name: 'a', block: wrong }, { name: 'b', block: wrong }], 0, deps, L, K, 1000)
    expect(res).toEqual({ isReorg: true, forkPoint: L - K })
  })

  it('a lone report with the other endpoint unavailable does NOT roll back', async () => {
    const err = await detectReorgPinned<Ep>([{ name: 'wrong', block: wrong }, { name: 'down', block: wrong }], 0, deps, L, K, 1000)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error) // rejected: the poll loop retries; nothing is deleted
  })

  it('a single configured endpoint is trusted alone, as before (nothing to corroborate with)', async () => {
    const res = await detectReorgPinned<Ep>([{ name: 'only', block: wrong }], 0, deps, L, K, 1000)
    expect(res).toEqual({ isReorg: true, forkPoint: L - K })
  })
})
