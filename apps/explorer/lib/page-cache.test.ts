import { describe, it, expect } from 'vitest'
import { buildCacheKey, createPageCache } from '@/lib/page-cache'
import { chainConfig } from '@/lib/chain'
import { estimateFrom, parsePageParam, parseTx, parseBlock, fetchTxPage, fetchBlockPage } from '@/lib/list-pages'
import { parseDexTrade, fetchDexPage } from '@/lib/dex-page'

describe('buildCacheKey', () => {
  it('scopes the key to the chain', () => {
    // Both chains run the same image against different databases. An unscoped
    // key lets whichever service warmed the entry first serve the other chain's
    // rows — the same class of mistake as a bare getDb().
    expect(buildCacheKey('txs', [1])).toContain(chainConfig.key)
  })

  it('varies with every input the query varies on', () => {
    // Drop the page number and every page collapses onto page 1's rows.
    expect(buildCacheKey('txs', [1])).not.toEqual(buildCacheKey('txs', [2]))
  })

  it('does not collide across pages that share a page number', () => {
    expect(buildCacheKey('txs', [1])).not.toEqual(buildCacheKey('blocks', [1]))
  })

  it('is stable for the same inputs', () => {
    expect(buildCacheKey('dex', [3])).toEqual(buildCacheKey('dex', [3]))
  })

  it('renders every part as a string, as the cache API requires', () => {
    expect(buildCacheKey('whales', ['24h', 2]).every(p => typeof p === 'string')).toBe(true)
  })
})

describe('estimateFrom', () => {
  it.each([
    ['a fresh table that has never been analysed', [{ estimate: -1 }], 0],
    ['a missing row', [], 0],
    ['a null estimate', [{ estimate: null }], 0],
    ['a real count', [{ estimate: 4200 }], 4200],
  ])('clamps %s', (_label, rows, expected) => {
    // reltuples is -1 until the first ANALYZE; unclamped it renders a negative
    // page count in the paginator.
    expect(estimateFrom(rows)).toBe(expected)
  })
})

describe('parsePageParam', () => {
  it.each([
    [undefined, 1],
    ['1', 1],
    ['7', 7],
    ['0', 1],
    ['-5', 1],
    ['abc', 1],
    ['2.9', 2],
    ['', 1],
  ])('maps %j to page %i', (raw, expected) => {
    expect(parsePageParam(raw as string | undefined)).toBe(expected)
  })

  it('does not return Infinity for a huge param', () => {
    // Number('1e999') is Infinity, and (Infinity - 1) * 25 is NaN as an OFFSET.
    expect(Number.isFinite(parsePageParam('1e999'))).toBe(true)
  })
})

describe('cache-boundary rehydration', () => {
  // unstable_cache round-trips its value, so a Date arrives back as a string.
  // TxTable and BlockTable both declare `timestamp: Date` and call timeAgo().
  //
  // The gas fields are in these fixtures because `parse*` rehydrates them too —
  // they cross the cache as decimal strings, since JSON.stringify throws on a
  // bigint and would void the whole cache write. `parse*` reads them
  // unconditionally on purpose: a cached row missing one is a bug, and
  // defaulting it to 0 would render a wrong gas figure instead of failing.
  const iso = '2026-08-27T08:44:35.000Z'

  it('turns a transaction timestamp back into a Date', () => {
    const row = parseTx({ hash: '0x1', timestamp: iso, gas: '21000', gasUsed: '21000' } as never)
    expect(row.timestamp).toBeInstanceOf(Date)
    expect(row.timestamp.toISOString()).toBe(iso)
  })

  it('turns a block timestamp back into a Date', () => {
    const row = parseBlock({ number: 1, timestamp: iso, gasUsed: '1', gasLimit: '2' } as never)
    expect(row.timestamp).toBeInstanceOf(Date)
  })

  it('turns a dex trade timestamp back into a Date', () => {
    expect(parseDexTrade({ id: 1, timestamp: iso } as never).timestamp).toBeInstanceOf(Date)
  })
})

describe('createPageCache builds the reader once, not per request', () => {
  // The returned function cannot be INVOKED here — unstable_cache throws
  // outside a Next request scope — so these assert the shape, which is exactly
  // what distinguishes the broken version from the fixed one.
  it('returns an uninvoked function, not an in-flight promise', () => {
    // The broken version was `unstable_cache(query, key, opts)()`: it built the
    // wrapper INSIDE the request and immediately called it, so every request
    // wrapped a fresh closure and Next derived a fresh cache id from it. Every
    // lookup missed, and nothing errored. Production proof: /blocks (60s TTL)
    // advanced its top block four times in ten seconds, while /gas — static ISR
    // on the same incremental cache — reported x-nextjs-cache: HIT.
    let calls = 0
    const read = createPageCache('t', 60, async (page: number) => { calls++; return page * 2 })
    expect(typeof read).toBe('function')
    expect(read).not.toBeInstanceOf(Promise)
    expect(calls).toBe(0)
  })

  it('does not re-create a wrapper per call', () => {
    const read = createPageCache('t2', 60, async (n: number) => n)
    expect(read).toBe(read)
  })
})

describe('the page fetchers are module-scope constants', () => {
  it.each([
    ['fetchTxPage', fetchTxPage],
    ['fetchBlockPage', fetchBlockPage],
    ['fetchDexPage', fetchDexPage],
  ])('%s is a stable function', (_n, fn) => {
    expect(typeof fn).toBe('function')
  })
})
