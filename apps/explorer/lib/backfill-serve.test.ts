import { describe, expect, it } from 'vitest'
import { encodeCursor, decodeCursor, txToHistoryRow } from './backfill-serve'

/**
 * The cursor codec encodes WHICH SOURCE the next page comes from. Getting this
 * wrong is not a rendering bug — a `local` cursor that decodes as `head` silently
 * restarts pagination at page 1, and a garbage cursor that decodes as `local`
 * serves cached rows where the user expected live ones.
 */
describe('backfill cursor codec', () => {
  it('round-trips a local keyset cursor', () => {
    const c = encodeCursor({ source: 'local', blockNumber: 25526988, txHash: '0xabc' })
    expect(decodeCursor(c)).toEqual({ source: 'local', blockNumber: 25526988, txHash: '0xabc' })
  })

  it('round-trips a local cursor carrying a logIndex (token transfers)', () => {
    const c = encodeCursor({ source: 'local', blockNumber: 42, txHash: '0xdef', logIndex: 7 })
    expect(decodeCursor(c)).toEqual({ source: 'local', blockNumber: 42, txHash: '0xdef', logIndex: 7 })
  })

  it('round-trips a provider passthrough cursor', () => {
    const c = encodeCursor({ source: 'provider', providerCursor: 'eyIx' })
    expect(decodeCursor(c)).toEqual({ source: 'provider', providerCursor: 'eyIx' })
  })

  // R1: the head is ALWAYS live. Nothing may decode to a local first page.
  it('treats a null/undefined/garbage cursor as the live head', () => {
    expect(decodeCursor(null)).toEqual({ source: 'head' })
    expect(decodeCursor(undefined)).toEqual({ source: 'head' })
    expect(decodeCursor('not-base64-json')).toEqual({ source: 'head' })
    expect(decodeCursor('')).toEqual({ source: 'head' })
  })

  it('rejects a local cursor missing its keyset boundary', () => {
    // Without both parts the keyset predicate is meaningless; falling back to
    // the live head is the only safe reading.
    const noBoundary = Buffer.from(JSON.stringify({ source: 'local' }), 'utf8').toString('base64url')
    const halfBoundary = Buffer.from(JSON.stringify({ source: 'local', blockNumber: 1 }), 'utf8').toString('base64url')
    expect(decodeCursor(noBoundary)).toEqual({ source: 'head' })
    expect(decodeCursor(halfBoundary)).toEqual({ source: 'head' })
  })

  it('rejects a provider cursor with no provider string, and unknown sources', () => {
    const noCur = Buffer.from(JSON.stringify({ source: 'provider' }), 'utf8').toString('base64url')
    const bogus = Buffer.from(JSON.stringify({ source: 'wat', blockNumber: 1 }), 'utf8').toString('base64url')
    expect(decodeCursor(noCur)).toEqual({ source: 'head' })
    expect(decodeCursor(bogus)).toEqual({ source: 'head' })
  })

  it('rejects a non-object payload', () => {
    for (const v of ['null', '42', '"str"', '[]']) {
      expect(decodeCursor(Buffer.from(v, 'utf8').toString('base64url'))).toEqual({ source: 'head' })
    }
  })
})

describe('txToHistoryRow', () => {
  it('projects exactly the served fields and fabricates nothing', () => {
    const row = txToHistoryRow({
      hash: '0x1', blockNumber: '10', blockTimestamp: '2026-07-18T00:00:00Z',
      fromAddress: '0xa', toAddress: '0xb', value: '5',
      gasPrice: '99', gasUsed: '21000',
      category: 'send', summary: 'Sent 5', possibleSpam: false,
      erc20Transfers: [{ tokenSymbol: 'X', contractAddress: '0xc', valueFormatted: '1', direction: 'send' }],
    } as never)

    expect(row).toEqual({
      hash: '0x1', blockNumber: '10', blockTimestamp: '2026-07-18T00:00:00Z',
      fromAddress: '0xa', toAddress: '0xb', value: '5',
      category: 'send', summary: 'Sent 5', possibleSpam: false,
    })
    // The whole point of the HistoryRow projection: no gas/erc20 leakage, so a
    // backfilled row and a provider row are indistinguishable to the client and
    // neither has to invent gasPrice:'0'.
    expect('gasPrice' in row).toBe(false)
    expect('erc20Transfers' in row).toBe(false)
  })
})

describe('cursor codec — hostile input (these cursors are forgeable)', () => {
  // Local cursors are NOT unforgeable: anyone can base64url a payload and reach
  // the cached path. That is tolerable (the address comes from the route path,
  // never the cursor, so there is no cross-entity access), but every field
  // reaches a SQL keyset predicate and must be validated as if hostile.
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')

  it('rejects non-finite / unsafe / negative block numbers', () => {
    for (const blk of [-1, 1.5, 1e21, Number.MAX_VALUE]) {
      expect(decodeCursor(enc({ source: 'local', blockNumber: blk, txHash: '0xab' })))
        .toEqual({ source: 'head' })
    }
    // NaN and Infinity do not survive JSON at all — they arrive as null.
    expect(decodeCursor(enc({ source: 'local', blockNumber: null, txHash: '0xab' })))
      .toEqual({ source: 'head' })
  })

  it('rejects a txHash that is not 0x-hex', () => {
    for (const h of ['nope', '0x', '0xzz', "0xab'; DROP TABLE--", '', 42]) {
      expect(decodeCursor(enc({ source: 'local', blockNumber: 1, txHash: h })))
        .toEqual({ source: 'head' })
    }
  })

  it('rejects a negative or fractional logIndex', () => {
    for (const li of [-1, 2.5, '3']) {
      expect(decodeCursor(enc({ source: 'local', blockNumber: 1, txHash: '0xab', logIndex: li })))
        .toEqual({ source: 'head' })
    }
  })

  it('accepts a well-formed hostile-looking but valid cursor', () => {
    expect(decodeCursor(enc({ source: 'local', blockNumber: 0, txHash: '0xAB', logIndex: 0 })))
      .toEqual({ source: 'local', blockNumber: 0, txHash: '0xAB', logIndex: 0 })
  })
})

// ── O1: the live/local seam ordering contract ──────────────────────────────
//
// Moralis specifies no within-block order, so the handoff cursor anchors at
// (boundaryBlock, TOP_HASH) and carries the live page's boundary-block rows as
// an exclusion list. These tests pin the codec, the carry rule, and the
// mint-side collectors; the end-to-end predicate behavior (no skips, no dups,
// pair precision) runs against a real Postgres in backfill-serve.pg.test.ts.
import {
  carrySeamExclusions,
  collectSeenTransferKeys,
  collectSeenTxHashes,
  transferHandoffKeys,
  SEEN_CAP,
  TOP_HASH,
  TOP_LOG_INDEX,
} from './backfill-serve'

describe('O1 cursor codec — seam fields', () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')

  it('round-trips a seen-hash handoff cursor, lowercasing the hashes', () => {
    const c = encodeCursor({
      source: 'local', blockNumber: 100, txHash: TOP_HASH,
      boundaryBlock: 100, seenTxHashes: ['0xAA', '0xbb'],
    })
    expect(decodeCursor(c)).toEqual({
      source: 'local', blockNumber: 100, txHash: TOP_HASH,
      boundaryBlock: 100, seenTxHashes: ['0xaa', '0xbb'],
    })
  })

  it('round-trips a seen-pair transfer cursor', () => {
    const c = encodeCursor({
      source: 'local', blockNumber: 100, txHash: TOP_HASH, logIndex: TOP_LOG_INDEX,
      boundaryBlock: 100, seenTransferKeys: [{ h: '0xAA', i: 3 }],
    })
    expect(decodeCursor(c)).toEqual({
      source: 'local', blockNumber: 100, txHash: TOP_HASH, logIndex: TOP_LOG_INDEX,
      boundaryBlock: 100, seenTransferKeys: [{ h: '0xaa', i: 3 }],
    })
  })

  it('the TOP_HASH sentinel itself is a valid txHash', () => {
    expect(decodeCursor(enc({ source: 'local', blockNumber: 1, txHash: TOP_HASH })))
      .toEqual({ source: 'local', blockNumber: 1, txHash: TOP_HASH })
  })

  it('rejects seam fields that do not form a coherent set', () => {
    const base = { source: 'local', blockNumber: 100, txHash: TOP_HASH }
    for (const extra of [
      { boundaryBlock: 100 },                                        // block, no list
      { seenTxHashes: ['0xaa'] },                                    // list, no block
      { logIndex: 1, seenTransferKeys: [{ h: '0xaa', i: 1 }] },      // list, no block
      { boundaryBlock: 100, seenTxHashes: [] },                      // empty list
      { boundaryBlock: 100, logIndex: 1, seenTransferKeys: [] },     // empty list
      { boundaryBlock: -1, seenTxHashes: ['0xaa'] },                 // bad block
      { boundaryBlock: 1.5, seenTxHashes: ['0xaa'] },                // bad block
      // only ever minted with boundaryBlock === blockNumber — a forged
      // mismatch could apply the exclusions to an unrelated block
      { boundaryBlock: 99, seenTxHashes: ['0xaa'] },
      // exclusion kind must match the endpoint: hashes ride tx cursors
      // (no logIndex), pairs ride transfer cursors (logIndex present)
      { logIndex: 1, boundaryBlock: 100, seenTxHashes: ['0xaa'] },
      { boundaryBlock: 100, seenTransferKeys: [{ h: '0xaa', i: 1 }] },
      { boundaryBlock: 100, seenTxHashes: ['0xaa'], seenTransferKeys: [{ h: '0xaa', i: 1 }] }, // both kinds
    ]) {
      expect(decodeCursor(enc({ ...base, ...extra })), JSON.stringify(extra))
        .toEqual({ source: 'head' })
    }
  })

  it('rejects hostile exclusion entries', () => {
    const hashBase = { source: 'local', blockNumber: 100, txHash: TOP_HASH, boundaryBlock: 100 }
    for (const seenTxHashes of [
      ["0xab'; DROP TABLE--"], ['nope'], [42], ['0xaa', ''], 'not-an-array',
      Array.from({ length: SEEN_CAP + 1 }, () => '0xaa'),            // over cap
    ]) {
      expect(decodeCursor(enc({ ...hashBase, seenTxHashes })), JSON.stringify(seenTxHashes).slice(0, 60))
        .toEqual({ source: 'head' })
    }
    const pairBase = { ...hashBase, logIndex: TOP_LOG_INDEX }
    for (const seenTransferKeys of [
      [{ h: 'nope', i: 1 }], [{ h: '0xaa', i: -1 }], [{ h: '0xaa', i: 1.5 }],
      [{ h: '0xaa', i: '2' }], [{ h: '0xaa', i: TOP_LOG_INDEX + 1 }], // beyond int4
      [{ h: '0xaa' }], ['0xaa'], [null],
      Array.from({ length: SEEN_CAP + 1 }, () => ({ h: '0xaa', i: 1 })),
    ]) {
      expect(decodeCursor(enc({ ...pairBase, seenTransferKeys })), JSON.stringify(seenTransferKeys).slice(0, 60))
        .toEqual({ source: 'head' })
    }
  })
})

describe('O1 carrySeamExclusions — the exclusion must outlive the first local page', () => {
  const cur = {
    source: 'local' as const, blockNumber: 100, txHash: TOP_HASH,
    boundaryBlock: 100, seenTxHashes: ['0xaa', '0xbb'],
  }

  it('carries the fields while the page still ends inside the boundary block', () => {
    // Dropping them here is the bug class: the next page's tuple boundary sits
    // below some seen hashes, which would then be re-served as duplicates.
    expect(carrySeamExclusions(cur, 100))
      .toEqual({ boundaryBlock: 100, seenTxHashes: ['0xaa', '0xbb'] })
  })

  it('drops the fields once the keyset descends below the boundary block', () => {
    expect(carrySeamExclusions(cur, 99)).toEqual({})
  })

  it('is a no-op for cursors that never had seam fields', () => {
    expect(carrySeamExclusions({ source: 'local', blockNumber: 100, txHash: '0xaa' }, 100))
      .toEqual({})
  })

  it('carries transfer pairs the same way', () => {
    const tcur = {
      source: 'local' as const, blockNumber: 100, txHash: TOP_HASH,
      logIndex: TOP_LOG_INDEX,
      boundaryBlock: 100, seenTransferKeys: [{ h: '0xaa', i: 1 }],
    }
    expect(carrySeamExclusions(tcur, 100))
      .toEqual({ boundaryBlock: 100, seenTransferKeys: [{ h: '0xaa', i: 1 }] })
    expect(carrySeamExclusions(tcur, 42)).toEqual({})
  })
})

describe('O1 mint-side collectors', () => {
  it('collectSeenTxHashes takes only boundary-block rows, lowercased, de-duplicated', () => {
    const rows = [
      { blockNumber: '101', hash: '0xAA' },
      { blockNumber: '100', hash: '0xBB' },
      { blockNumber: '100', hash: '0xbb' },
      { blockNumber: '100', hash: '0xcc' },
    ] as never[]
    expect(collectSeenTxHashes(rows, 100)).toEqual(['0xbb', '0xcc'])
  })

  it('collectSeenTransferKeys drops null/empty/non-numeric/beyond-int4 logIndex instead of coercing', () => {
    // Number('') is 0 — coercing would fabricate a (hash, 0) exclusion and
    // silently drop a real cached row; a beyond-int4 value would mint a
    // cursor decodeCursor rejects on the next request.
    const rows = [
      { blockNumber: '100', txHash: '0xAA', logIndex: '3' },
      { blockNumber: '100', txHash: '0xaa', logIndex: '3' },
      { blockNumber: '100', txHash: '0xbb', logIndex: null },
      { blockNumber: '100', txHash: '0xcc', logIndex: '' },
      { blockNumber: '100', txHash: '0xdd', logIndex: 'x' },
      { blockNumber: '100', txHash: '0xdd', logIndex: String(TOP_LOG_INDEX + 1) },
      { blockNumber: '99', txHash: '0xee', logIndex: '1' },
    ] as never[]
    expect(collectSeenTransferKeys(rows, 100)).toEqual([{ h: '0xaa', i: 3 }])
  })

  it('transferHandoffKeys is ALL-OR-SKIP: one invalid boundary row kills the handoff', () => {
    // A row null HERE may sit in the cache under a valid index from an
    // earlier fetch (Moralis returns indexes inconsistently); an exclusion
    // list that silently omitted it would re-serve it as a seam duplicate.
    const good = [
      { blockNumber: '100', txHash: '0xAA', logIndex: '2' },
      { blockNumber: '100', txHash: '0xbb', logIndex: '0' },
      { blockNumber: '99', txHash: '0xee', logIndex: null }, // below boundary — irrelevant
    ] as never[]
    expect(transferHandoffKeys(good, 100)).toEqual([
      { h: '0xaa', i: 2 },
      { h: '0xbb', i: 0 },
    ])
    for (const bad of [null, '', 'x', String(TOP_LOG_INDEX + 1)]) {
      const rows = [...good, { blockNumber: '100', txHash: '0xcc', logIndex: bad }] as never[]
      expect(transferHandoffKeys(rows, 100), JSON.stringify(bad)).toBeNull()
    }
  })
})
