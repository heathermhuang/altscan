import { describe, expect, it } from 'vitest'
import { Interface, JsonRpcProvider, Network, encodeBytes32String } from 'ethers'
import {
  HEAL_MAX_PAGES, HEAL_RETRY_MS, TRANSPORT_STREAK_LIMIT, TRANSPORT_STRIKE_LIMIT, UNKNOWN_NAME, UNKNOWN_SYMBOL,
  decideHeal, describeHealCursor, fetchTokenMetadata, isTransportError, planHeal, pruneTried, resumeHealCursor,
  scanHealCandidates, collectHealRun, selectHeadBatch,
  type CallRunner, type FetchedTokenMetadata, type HealCursor, type HealPageSource, type HealRow, type TokenMetadata,
} from './token-metadata'

const TOKEN = '0x55d398326f99059ff775485246999027b3197955'
const stringAbi = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])
const selector = (fn: string) => stringAbi.getFunction(fn)!.selector

type Reply = string | Error
/** A provider that answers each selector from `replies` and counts the calls. */
function mockRunner(replies: Partial<Record<'name' | 'symbol' | 'decimals' | 'totalSupply', Reply>>) {
  const bySelector = new Map(Object.entries(replies).map(([fn, r]) => [selector(fn), r as Reply]))
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const runner: CallRunner = {
    async call({ to, data }) {
      calls.push(`${to}:${data}`)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
      const reply = bySelector.get(data.slice(0, 10))
      if (reply === undefined) throw new Error('unexpected selector')
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return { runner, calls, maxInFlight: () => maxInFlight }
}

const encode = (fn: string, value: unknown) => stringAbi.encodeFunctionResult(fn, [value])
const revert = () => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' })
const rateLimited = () => Object.assign(
  new Error('method eth_call in batch triggered rate limit'), { code: 'SERVER_ERROR' })

describe('fetchTokenMetadata', () => {
  it('decodes the string ABI', async () => {
    const { runner } = mockRunner({
      name: encode('name', 'Tether USD'),
      symbol: encode('symbol', 'USDT'),
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 10n ** 27n),
    })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: 'Tether USD', symbol: 'USDT', decimals: 18, totalSupply: (10n ** 27n).toString(),
      transportFailed: false,
    })
  })

  it('falls back to bytes32 for name and symbol (MKR)', async () => {
    const { runner, calls } = mockRunner({
      name: encodeBytes32String('Maker'),
      symbol: encodeBytes32String('MKR'),
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 1n),
    })
    const meta = await fetchTokenMetadata(runner, TOKEN)
    expect(meta.name).toBe('Maker')
    expect(meta.symbol).toBe('MKR')
    // name() and symbol() share one selector across both ABIs, so the fallback is a decode, not a retry.
    expect(calls).toHaveLength(4)
  })

  it('accepts a bytes32 that fills all 32 bytes (no NUL terminator)', async () => {
    const full = 'A'.repeat(32)
    const { runner } = mockRunner({
      name: '0x' + Buffer.from(full).toString('hex'),
      symbol: encodeBytes32String('X'),
      decimals: encode('decimals', 6),
      totalSupply: encode('totalSupply', 5n),
    })
    expect((await fetchTokenMetadata(runner, TOKEN)).name).toBe(full)
  })

  it('leaves a bytes32 that is not UTF-8 unresolved instead of storing garbage', async () => {
    const { runner } = mockRunner({
      name: '0xff' + 'fe'.repeat(31),
      symbol: '0x' + '00'.repeat(31) + '40', // a number, not left-aligned text
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 1n),
    })
    const meta = await fetchTokenMetadata(runner, TOKEN)
    expect(meta.name).toBeNull()
    expect(meta.symbol).toBeNull()
  })

  it('returns null for a field whose call reverts, and keeps the others', async () => {
    const { runner } = mockRunner({
      name: revert(),
      symbol: encode('symbol', 'USDT'),
      decimals: revert(),
      totalSupply: revert(),
    })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: null, symbol: 'USDT', decimals: null, totalSupply: null, transportFailed: false,
    })
  })

  it('returns null, not a throw, when the endpoint rate-limits every call', async () => {
    const { runner, calls } = mockRunner({
      name: rateLimited(), symbol: rateLimited(), decimals: rateLimited(), totalSupply: rateLimited(),
    })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: null, symbol: null, decimals: null, totalSupply: null, transportFailed: true,
    })
    // No hidden retry on the throttled endpoint.
    expect(calls).toHaveLength(4)
  })

  it('treats empty return data (an address with no code) as unresolved', async () => {
    const { runner } = mockRunner({ name: '0x', symbol: '0x', decimals: '0x', totalSupply: '0x' })
    expect(await fetchTokenMetadata(runner, TOKEN)).toEqual({
      name: null, symbol: null, decimals: null, totalSupply: null, transportFailed: false,
    })
  })

  it('strips control bytes and truncates like sanitizeTokenMetadata did', async () => {
    const { runner } = mockRunner({
      name: encode('name', 'Bad\u0000Token\u0007' + 'x'.repeat(300)),
      symbol: encode('symbol', 'S'.repeat(80)),
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 1n),
    })
    const meta = await fetchTokenMetadata(runner, TOKEN)
    expect(meta.name).toHaveLength(255)
    expect(meta.name!.startsWith('BadToken')).toBe(true)
    expect(meta.symbol).toHaveLength(50)
  })

  it('treats a blank name as unresolved so the caller picks the placeholder', async () => {
    const { runner } = mockRunner({
      name: encode('name', '\u0000 \u0007'),
      symbol: encode('symbol', ''),
      decimals: encode('decimals', 18),
      totalSupply: encode('totalSupply', 0n),
    })
    const meta = await fetchTokenMetadata(runner, TOKEN)
    expect(meta.name ?? UNKNOWN_NAME).toBe('Unknown')
    expect(meta.symbol ?? UNKNOWN_SYMBOL).toBe('???')
    expect(meta.totalSupply).toBe('0')
  })

  it('fires the four calls together by default and one at a time when sequential', async () => {
    const replies = {
      name: encode('name', 'A'), symbol: encode('symbol', 'A'),
      decimals: encode('decimals', 18), totalSupply: encode('totalSupply', 1n),
    }
    const together = mockRunner(replies)
    await fetchTokenMetadata(together.runner, TOKEN)
    expect(together.maxInFlight()).toBe(4)

    const serial = mockRunner(replies)
    await fetchTokenMetadata(serial.runner, TOKEN, { sequential: true })
    expect(serial.maxInFlight()).toBe(1)
  })
})

const meta = (over: Partial<TokenMetadata> = {}): TokenMetadata =>
  ({ name: 'Tether USD', symbol: 'USDT', decimals: 18, totalSupply: '1000', ...over })
const row = (over: Partial<HealRow> = {}): HealRow => ({
  address: TOKEN, name: UNKNOWN_NAME, symbol: UNKNOWN_SYMBOL, decimals: 18,
  totalSupply: '0', type: 'BEP20', holderCount: 835_871, ...over,
})

/**
 * The candidate list as the SQL serves it: ordered (holder_count DESC, address DESC),
 * a page being the rows strictly after the cursor — the row comparison in
 * token-heal-query.ts. No suite here runs that SQL; it was checked against Postgres.
 */
function pageSourceOf(rows: HealRow[]) {
  const sorted = [...rows].sort((a, b) =>
    b.holderCount - a.holderCount || (a.address < b.address ? 1 : a.address > b.address ? -1 : 0))
  const calls: Array<{ after: HealCursor | null; limit: number }> = []
  const fetchPage: HealPageSource = async (after, limit) => {
    calls.push({ after, limit })
    return sorted
      .filter(r => after === null || r.holderCount < after.holderCount
        || (r.holderCount === after.holderCount && r.address < after.address))
      .slice(0, limit)
  }
  // The head: candidates with >= 2 holders from the top, no cursor (token-heal-query.ts healHeadWhere).
  const headCalls: number[] = []
  const fetchHead = async () => {
    headCalls.push(headCalls.length)
    return sorted.filter(r => r.holderCount >= 2).slice(0, 500)
  }
  return { fetchPage, fetchHead, calls, headCalls }
}
const cand = (holderCount: number, address: string) => row({ holderCount, address })
const addrs = (scan: { taken: Array<{ row: HealRow }> }) => scan.taken.map(t => t.row.address)

describe('planHeal', () => {
  it('writes every field that resolved over a placeholder', () => {
    expect(planHeal(row(), meta({ decimals: 6 }))).toEqual({
      name: 'Tether USD', symbol: 'USDT', totalSupply: '1000', decimals: 6,
    })
  })

  it('never overwrites a real value, and a failed fetch writes nothing', () => {
    expect(planHeal(row(), meta({ name: null, symbol: null, decimals: null, totalSupply: null }))).toBeNull()
    // Real name and supply are left alone even if the chain now says something else.
    const real = row({ name: 'Real Name', totalSupply: '5' })
    expect(planHeal(real, meta({ name: 'Other', totalSupply: '9' }))).toEqual({ symbol: 'USDT' })
  })

  it('does not treat the placeholder itself as a resolved value', () => {
    expect(planHeal(row(), meta({ name: UNKNOWN_NAME, symbol: UNKNOWN_SYMBOL, totalSupply: '0' }))).toBeNull()
  })

  it('heals an empty-string name or symbol', () => {
    expect(planHeal(row({ name: '', symbol: '' }), meta({ totalSupply: '0' }))).toEqual({
      name: 'Tether USD', symbol: 'USDT',
    })
  })

  it('leaves a genuinely zero supply alone', () => {
    const r = row({ name: 'Real', symbol: 'RL' })
    expect(planHeal(r, meta({ totalSupply: '0' }))).toBeNull()
  })

  it('corrects decimals on their own, since they are immutable on chain', () => {
    const r = row({ name: 'Real', symbol: 'RL', totalSupply: '7' })
    expect(planHeal(r, meta({ decimals: 8 }))).toEqual({ decimals: 8 })
    expect(planHeal(r, meta({ decimals: 18 }))).toBeNull()
  })
})

describe('scanHealCandidates', () => {
  const NOW = 10 * HEAL_RETRY_MS
  const none = new Map<string, number>()
  // Ten candidates, all at 0 holders: only the address orders them, '0xj' first.
  const ties = 'abcdefghij'.split('').map(c => cand(0, `0x${c}`))

  it('starts at the top and stops at the row that filled the batch, not at the end of the page', async () => {
    const { fetchPage, calls } = pageSourceOf(ties)
    const scan = await scanHealCandidates(fetchPage, null, none, NOW, { batchSize: 3, pageSize: 6 })
    expect(addrs(scan)).toEqual(['0xj', '0xi', '0xh'])
    // The cursor is the last row EXAMINED. Moving it to the end of the 6-row page
    // would skip '0xg'..'0xe' until the next wrap.
    expect(scan.after).toEqual({ holderCount: 0, address: '0xh' })
    expect(scan).toMatchObject({ ended: false, pages: 1 })
    expect(calls).toEqual([{ after: null, limit: 6 }])
  })

  it('continues strictly after the cursor: a tie on holder count is broken by address, with no repeat and no skip', async () => {
    const { fetchPage } = pageSourceOf(ties)
    const seen: string[] = []
    let at: HealCursor | null = null
    for (let i = 0; i < 3; i++) {
      const scan = await scanHealCandidates(fetchPage, at, none, NOW, { batchSize: 3, pageSize: 6 })
      seen.push(...addrs(scan))
      at = scan.after
    }
    expect(seen).toEqual(['0xj', '0xi', '0xh', '0xg', '0xf', '0xe', '0xd', '0xc', '0xb'])
    expect(at).toEqual({ holderCount: 0, address: '0xb' })
  })

  it('crosses from one holder count to the next even though the address sorts the other way', async () => {
    // (1, '0x1') then (0, '0xf'): '0xf' > '0x1', but fewer holders sorts later.
    const { fetchPage } = pageSourceOf([cand(0, '0xf'), cand(1, '0x1'), cand(2, '0x9')])
    const first = await scanHealCandidates(fetchPage, null, none, NOW, { batchSize: 2, pageSize: 5 })
    expect(addrs(first)).toEqual(['0x9', '0x1'])
    expect(first.after).toEqual({ holderCount: 1, address: '0x1' })
    const second = await scanHealCandidates(fetchPage, first.after, none, NOW, { batchSize: 2, pageSize: 5 })
    expect(addrs(second)).toEqual(['0xf'])
  })

  it('treats a short page as the end of the list: ended, nothing after it, no second query', async () => {
    const { fetchPage, calls } = pageSourceOf(ties.slice(0, 5)) // 0xe..0xa
    const scan = await scanHealCandidates(fetchPage, null, none, NOW, { batchSize: 10, pageSize: 8 })
    expect(addrs(scan)).toEqual(['0xe', '0xd', '0xc', '0xb', '0xa'])
    expect(scan).toMatchObject({ ended: true, after: null, pages: 1 })
    expect(calls).toHaveLength(1)
    // ...and the run after it starts over at the top rather than from an empty tail.
    expect(resumeHealCursor(scan, () => true)).toEqual({ cursor: null, wrapped: true })
  })

  it('finds the end one page late when the list is an exact multiple of the page size', async () => {
    const { fetchPage } = pageSourceOf(ties.slice(0, 4))
    const scan = await scanHealCandidates(fetchPage, null, none, NOW, { batchSize: 10, pageSize: 4 })
    expect(addrs(scan)).toHaveLength(4)
    expect(scan).toMatchObject({ ended: true, after: null, pages: 2 })
  })

  it('does not call a short page the end when the batch was already filled inside it', async () => {
    const { fetchPage } = pageSourceOf(ties.slice(0, 3)) // 0xc, 0xb, 0xa
    const scan = await scanHealCandidates(fetchPage, null, none, NOW, { batchSize: 2, pageSize: 10 })
    expect(addrs(scan)).toEqual(['0xc', '0xb'])
    // '0xa' is still ahead; the next run finds it, THEN the end.
    expect(scan).toMatchObject({ ended: false, after: { holderCount: 0, address: '0xb' } })
  })

  it('skips addresses tried inside the window, and counts them as progress', async () => {
    const { fetchPage } = pageSourceOf(ties)
    const tried = new Map([['0xj', NOW - 1000], ['0xh', NOW - HEAL_RETRY_MS + 1]])
    const scan = await scanHealCandidates(fetchPage, null, tried, NOW, { batchSize: 2, pageSize: 6 })
    expect(addrs(scan)).toEqual(['0xi', '0xg'])
    expect(scan.after).toEqual({ holderCount: 0, address: '0xg' })
  })

  it('retries an address once its window has passed', async () => {
    const { fetchPage } = pageSourceOf(ties)
    const tried = new Map([['0xj', NOW - HEAL_RETRY_MS]])
    const scan = await scanHealCandidates(fetchPage, null, tried, NOW, { batchSize: 1, pageSize: 6 })
    expect(addrs(scan)).toEqual(['0xj'])
  })

  it('fills the batch across pages when a page is mostly tried rows', async () => {
    const { fetchPage, calls } = pageSourceOf(ties)
    // The top six are tried: page 1 (0xj..0xh) and page 2 (0xg..0xe) hold none.
    const tried = new Map('jihgfe'.split('').map(c => [`0x${c}`, NOW - 1] as [string, number]))
    const scan = await scanHealCandidates(fetchPage, null, tried, NOW, { batchSize: 3, pageSize: 3 })
    expect(addrs(scan)).toEqual(['0xd', '0xc', '0xb'])
    expect(scan.pages).toBe(3)
    expect(scan.taken[0].prev).toEqual({ holderCount: 0, address: '0xe' })
    expect(calls.map(c => c.after?.address ?? null)).toEqual([null, '0xh', '0xe'])
  })

  it('gives up after maxPages but still advances, so the next run starts further in', async () => {
    const { fetchPage } = pageSourceOf(ties)
    const tried = new Map(ties.map(r => [r.address, NOW - 1] as [string, number]))
    const scan = await scanHealCandidates(fetchPage, null, tried, NOW, { batchSize: 2, pageSize: 3, maxPages: 2 })
    expect(scan.taken).toEqual([])
    expect(scan).toMatchObject({ ended: false, pages: 2, after: { holderCount: 0, address: '0xe' } })
    expect(HEAL_MAX_PAGES).toBe(5)
  })

  // The production failure this exists for: the head of the list never heals, so a
  // list-from-the-top that skips what it tried runs dry once those are all tried.
  // Walking by cursor reaches the healable rows behind them.
  it('reaches rows far behind an unhealable head, and visits each row once per cycle', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => cand(100 - i, `0x${String(i).padStart(3, '0')}`))
    const { fetchPage } = pageSourceOf(rows)
    const tried = new Map<string, number>()
    const attempted: string[] = []
    let at: HealCursor | null = null
    let wraps = 0
    for (let run = 0; run < 10 && wraps === 0; run++) {
      const scan = await scanHealCandidates(fetchPage, at, tried, NOW, { batchSize: 40, pageSize: 80 })
      for (const t of scan.taken) { attempted.push(t.row.address); tried.set(t.row.address, NOW) }
      const resume = resumeHealCursor(scan, r => tried.has(r.address))
      at = resume.cursor
      if (resume.wrapped) wraps++
    }
    expect(attempted).toEqual(rows.map(r => r.address))
    expect(wraps).toBe(1)
    expect(at).toBeNull()

    // Straight after the wrap everything is still inside its window: a run that
    // reads the whole list finds nothing to do, and wraps again.
    const idle = await scanHealCandidates(fetchPage, at, tried, NOW + 1, { batchSize: 40, pageSize: 80 })
    expect(idle.taken).toEqual([])
    expect(idle.ended).toBe(true)

    // A day later the list is open again, from the top.
    const again = await scanHealCandidates(fetchPage, at, tried, NOW + HEAL_RETRY_MS, { batchSize: 40, pageSize: 80 })
    expect(addrs(again)[0]).toBe(rows[0].address)
  })
})

describe('selectHeadBatch', () => {
  const NOW = 10 * HEAL_RETRY_MS
  const rows = [cand(9, '0xa'), cand(8, '0xb'), cand(7, '0xc')]

  it('skips rows tried inside the window, keeps list order, and stops at the batch size', () => {
    const tried = new Map([['0xa', NOW - 1]])
    expect(selectHeadBatch(rows, tried, NOW, 5).map(r => r.address)).toEqual(['0xb', '0xc'])
    expect(selectHeadBatch(rows, new Map(), NOW, 2).map(r => r.address)).toEqual(['0xa', '0xb'])
  })

  it('offers a row again once its window has passed', () => {
    const tried = new Map([['0xa', NOW - HEAL_RETRY_MS]])
    expect(selectHeadBatch(rows, tried, NOW, 1).map(r => r.address)).toEqual(['0xa'])
  })
})

describe('collectHealRun — head first, keyset tail after', () => {
  const NOW = 10 * HEAL_RETRY_MS
  const none = new Map<string, number>()
  const opts = { batchSize: 5, pageSize: 10 }
  // Two climbers (5 and 3 holders) above ten 0-holder rows '0xj'..'0xa'.
  const climbers = [cand(5, '0xp'), cand(3, '0xq')]
  const stock = 'abcdefghij'.split('').map(c => cand(0, `0x${c}`))
  const all = [...climbers, ...stock]
  const order = (run: { head: HealRow[]; scan: { taken: Array<{ row: HealRow }> } }) =>
    [...run.head, ...run.scan.taken.map(t => t.row)].map(r => r.address)

  it('attempts the head first, then fills the rest of the batch from the cursor', async () => {
    const { fetchPage, fetchHead } = pageSourceOf(all)
    const start = { holderCount: 0, address: '0xf' } // the tail has already passed 0xj..0xf
    const run = await collectHealRun(fetchHead, fetchPage, start, none, NOW, opts)
    expect(run.head.map(r => r.address)).toEqual(['0xp', '0xq'])
    expect(order(run)).toEqual(['0xp', '0xq', '0xe', '0xd', '0xc'])
  })

  it('picks up a candidate that climbed above a cursor that already passed it, next run', async () => {
    // The tail is deep in the 0-holder rows; '0xa' then gains holders. A cursor-only walk would
    // not see it until the lap wrapped; the head lists it from the top on the very next run.
    const { fetchPage, fetchHead } = pageSourceOf([...stock.filter(r => r.address !== '0xa'), cand(4, '0xa')])
    const run = await collectHealRun(fetchHead, fetchPage, { holderCount: 0, address: '0xc' }, none, NOW, opts)
    expect(run.head.map(r => r.address)).toEqual(['0xa'])
  })

  it('never takes a row twice: the tail passes over rows the head took, even from the top', async () => {
    const { fetchPage, fetchHead } = pageSourceOf(all)
    const run = await collectHealRun(fetchHead, fetchPage, null, none, NOW, opts)
    // From the top the tail meets 0xp and 0xq first; they are the head's, so it skips them.
    expect(order(run)).toEqual(['0xp', '0xq', '0xj', '0xi', '0xh'])
    expect(new Set(order(run)).size).toBe(order(run).length)
    expect(run.scan.after).toEqual({ holderCount: 0, address: '0xh' })
  })

  it('leaves the cursor to the tail: head rows neither move it nor hold it', async () => {
    const { fetchPage, fetchHead } = pageSourceOf(all)
    const start = { holderCount: 0, address: '0xf' }
    const run = await collectHealRun(fetchHead, fetchPage, start, none, NOW, opts)
    // Same cursor a head-less run would reach: just past the last TAIL row examined.
    const tailOnly = await scanHealCandidates(fetchPage, start, none, NOW, { batchSize: 3, pageSize: 10 })
    expect(run.scan.after).toEqual(tailOnly.after)
    expect(run.scan.after).toEqual({ holderCount: 0, address: '0xc' })
    expect(run.scan.taken.map(t => t.row.address)).toEqual(['0xe', '0xd', '0xc'])
    // The first tail row resumes from `start`, not from a head row.
    expect(run.scan.taken[0].prev).toEqual(start)
    // Every head row settled or not, the cursor is the tail's: all tail rows settled -> past them.
    expect(resumeHealCursor(run.scan, () => true).cursor).toEqual({ holderCount: 0, address: '0xc' })
  })

  it('does not read the tail at all when the head fills the batch', async () => {
    const heads = Array.from({ length: 7 }, (_, i) => cand(50 - i, `0x${i}`))
    const { fetchPage, fetchHead, calls } = pageSourceOf([...heads, ...stock])
    const start = { holderCount: 0, address: '0xf' }
    const run = await collectHealRun(fetchHead, fetchPage, start, none, NOW, opts)
    expect(run.head).toHaveLength(5)
    expect(calls).toEqual([])
    expect(run.scan).toEqual({ taken: [], after: start, ended: false, pages: 0 })
  })

  it('lets the tail fill the whole batch when the head is exhausted (tried, or empty)', async () => {
    const { fetchPage, fetchHead } = pageSourceOf(all)
    const tried = new Map(climbers.map(r => [r.address, NOW - 1] as [string, number]))
    const run = await collectHealRun(fetchHead, fetchPage, { holderCount: 0, address: '0xf' }, tried, NOW, opts)
    expect(run.head).toEqual([])
    expect(order(run)).toEqual(['0xe', '0xd', '0xc', '0xb', '0xa'])

    const none2 = pageSourceOf(stock)
    const empty = await collectHealRun(none2.fetchHead, none2.fetchPage, null, none, NOW, opts)
    expect(empty.head).toEqual([])
    expect(order(empty)).toEqual(['0xj', '0xi', '0xh', '0xg', '0xf'])
  })

  // A transport failure is not an answer. A tail row is held by the cursor; a head row
  // has no cursor to hold it, and does not need one: the head re-lists it every run.
  it('brings a head row that failed for a transport reason back next run, via the head', async () => {
    const { fetchPage, fetchHead } = pageSourceOf(all)
    const tried = new Map<string, number>()
    const start = { holderCount: 0, address: '0xf' }
    const run1 = await collectHealRun(fetchHead, fetchPage, start, tried, NOW, opts)
    // Run 1: 0xp fails on transport (not marked tried); 0xq and every tail row get answers.
    for (const r of order(run1)) if (r !== '0xp') tried.set(r, NOW)
    const resume = resumeHealCursor(run1.scan, r => tried.has(r.address))
    // The cursor goes past the whole tail: 0xp, being a head row, does not hold it back.
    expect(resume).toEqual({ cursor: { holderCount: 0, address: '0xc' }, wrapped: false })

    const run2 = await collectHealRun(fetchHead, fetchPage, resume.cursor, tried, NOW + 1, opts)
    expect(run2.head.map(r => r.address)).toEqual(['0xp'])            // back through the head
    expect(run2.scan.taken.map(t => t.row.address)).toEqual(['0xb', '0xa']) // tail continues from its own cursor
  })

  it('still holds the cursor for an unsettled TAIL row in the same run', async () => {
    const { fetchPage, fetchHead } = pageSourceOf(all)
    const start = { holderCount: 0, address: '0xf' }
    const run = await collectHealRun(fetchHead, fetchPage, start, none, NOW, opts)
    // 0xd failed on transport: the cursor stops just before it.
    expect(resumeHealCursor(run.scan, r => r.address !== '0xd').cursor).toEqual({ holderCount: 0, address: '0xe' })
  })
})

describe('resumeHealCursor', () => {
  const NOW = 10 * HEAL_RETRY_MS
  const none = new Map<string, number>()
  const four = ['a', 'b', 'c', 'd'].map((c, i) => cand(4 - i, `0x${c}`))
  const scanFour = () => scanHealCandidates(pageSourceOf(four).fetchPage, null, none, NOW, { batchSize: 3, pageSize: 4 })

  it('resumes just past everything examined when every taken row was settled', async () => {
    const scan = await scanFour()
    expect(resumeHealCursor(scan, () => true)).toEqual({ cursor: { holderCount: 2, address: '0xc' }, wrapped: false })
  })

  // A transport failure is not an answer: the row is not marked tried and must be
  // seen first on the next run, as it was when every run listed from the top.
  it('stops just before the first row that was not settled, so it is offered again', async () => {
    const scan = await scanFour()
    const resume = resumeHealCursor(scan, r => r.address !== '0xb')
    expect(resume).toEqual({ cursor: { holderCount: 4, address: '0xa' }, wrapped: false })

    // The next run's scan starts at the unsettled row; the settled one after it is skipped by `tried`.
    const tried = new Map([['0xc', NOW]])
    const next = await scanHealCandidates(pageSourceOf(four).fetchPage, resume.cursor, tried, NOW, { batchSize: 3, pageSize: 4 })
    expect(addrs(next)).toEqual(['0xb', '0xd'])
  })

  it('leaves the unattempted rest of a batch for the next run when a run stops early', async () => {
    const scan = await scanFour()
    // Only the first row got an answer before the run stopped.
    expect(resumeHealCursor(scan, r => r.address === '0xa'))
      .toEqual({ cursor: { holderCount: 4, address: '0xa' }, wrapped: false })
  })

  it('stays at the top when the very first row is the unsettled one', async () => {
    const scan = await scanFour()
    const resume = resumeHealCursor(scan, () => false)
    expect(resume).toEqual({ cursor: null, wrapped: false })
    expect(describeHealCursor(resume)).toBe('top')
  })

  it('does not wrap while an unsettled row is still waiting, even at the end of the list', async () => {
    const scan = await scanHealCandidates(pageSourceOf(four).fetchPage, null, none, NOW, { batchSize: 9, pageSize: 9 })
    expect(scan.ended).toBe(true)
    expect(resumeHealCursor(scan, r => r.address !== '0xd'))
      .toEqual({ cursor: { holderCount: 2, address: '0xc' }, wrapped: false })
  })

  it('describes the position for the log line', () => {
    expect(describeHealCursor({ cursor: { holderCount: 0, address: '0x12ab34cd' }, wrapped: false })).toBe('(0, 0x12ab…)')
    expect(describeHealCursor({ cursor: null, wrapped: true })).toBe('wrapped')
  })
})

describe('pruneTried', () => {
  const NOW = 10 * HEAL_RETRY_MS

  it('prunes only the expired entries', () => {
    const tried = new Map([['0xa', NOW - HEAL_RETRY_MS], ['0xb', NOW - 1]])
    pruneTried(tried, NOW)
    expect([...tried.keys()]).toEqual(['0xb'])
  })
})

/** A real JsonRpcProvider whose endpoint answers every request with `respond`, so the
 *  errors under test are the ones ethers actually builds (not hand-made lookalikes). */
function endpoint(respond: () => { result?: string; error?: { code: number; message: string; data?: string } } | null) {
  const net = Network.from(56)
  class P extends JsonRpcProvider {
    async _send(payload: unknown) {
      const reqs = (Array.isArray(payload) ? payload : [payload]) as Array<{ id: number }>
      const out = reqs.map(r => ({ id: r.id, ...respond() }))
      return (respond() === null ? [] : out) as never
    }
  }
  return new P('http://endpoint.invalid', net, { staticNetwork: net, batchMaxCount: 1 })
}
const callOf = (p: JsonRpcProvider) => p.call({ to: TOKEN, data: '0x06fdde03' }).then(() => null, (e: unknown) => e)

describe('isTransportError', () => {
  it('reads a node rate limit out of the CALL_EXCEPTION ethers wraps it in', async () => {
    const err = await callOf(endpoint(() => ({ error: { code: -32005, message: 'method eth_call in batch triggered rate limit' } })))
    expect((err as { code: string }).code).toBe('CALL_EXCEPTION') // why the code alone is not enough
    expect(isTransportError(err)).toBe(true)
  })

  it('recognises -32005 on its own, whatever the message', () => {
    expect(isTransportError({ info: { error: { code: -32005, message: 'limit' } } })).toBe(true)
    expect(isTransportError({ error: { code: -32005, message: 'x' } })).toBe(true)
  })

  it.each([
    ['JSON-RPC -32007', { code: 'CALL_EXCEPTION', info: { error: { code: -32007, message: 'denied' } } }],
    ['JSON-RPC -32029', { code: 'CALL_EXCEPTION', info: { error: { code: -32029, message: 'denied' } } }],
    ['"Request limit reached"', { code: 'CALL_EXCEPTION', info: { error: { code: -32000, message: 'Request limit reached' } } }],
    ['a "limit reached" message', { code: 'UNKNOWN_ERROR', message: 'daily limit reached for this key' }],
    ['a "request limit" message', { code: 'UNKNOWN_ERROR', message: 'exceeded the request limit' }],
    ['a rate-limit message under another code', { code: 'UNKNOWN_ERROR', message: 'method eth_call in batch triggered rate limit' }],
    ['"Too Many Requests"', { code: 'CALL_EXCEPTION', info: { error: { code: -32000, message: 'Too Many Requests' } } }],
    ['HTTP 429', { code: 'SERVER_ERROR', message: 'bad response (status=429, ...)' }],
    ['an ethers TIMEOUT', { code: 'TIMEOUT', message: 'request timeout' }],
    ['a timeout message', new Error('[rpc-failover] token-heal fetch timed out after 15000ms')],
    ['a network error', { code: 'NETWORK_ERROR', message: 'could not detect network' }],
    ['a connection reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
  ])('treats %s as transport', (_what, err) => expect(isTransportError(err)).toBe(true))

  it('treats a batch with no response for the request as transport', async () => {
    const err = await callOf(endpoint(() => null))
    expect((err as { code: string }).code).toBe('BAD_DATA')
    expect(isTransportError(err)).toBe(true)
  })

  it('treats a revert as the contract answering, with or without revert data', async () => {
    const withData = await callOf(endpoint(() => ({ error: { code: 3, message: 'execution reverted: nope', data: '0x08c379a0' + '00'.repeat(31) + '20' + '00'.repeat(31) + '00' } })))
    const noData = await callOf(endpoint(() => ({ error: { code: 3, message: 'execution reverted' } })))
    expect((withData as { code: string }).code).toBe('CALL_EXCEPTION')
    expect(isTransportError(withData)).toBe(false)
    expect(isTransportError(noData)).toBe(false)
  })

  it('does not let a revert reason that mentions rate limits count as transport', () => {
    expect(isTransportError({
      code: 'CALL_EXCEPTION',
      message: 'execution reverted: rate limit exceeded',
      info: { error: { code: 3, message: 'execution reverted: rate limit exceeded', data: '0x08c379a0aa' } },
    })).toBe(false)
  })

  it('does not take textual error.data for revert data: a gateway timeout stays transport', () => {
    expect(isTransportError({
      code: 'CALL_EXCEPTION',
      info: { error: { code: -32000, message: 'request timed out', data: 'upstream timeout' } },
    })).toBe(true)
    expect(isTransportError({ code: 'UNKNOWN_ERROR', message: 'bad gateway', data: 'upstream connect error' })).toBe(true)
  })

  it('takes hex-encoded error.data as a real revert payload: the contract answered', () => {
    const payload = '0x08c379a0' + '00'.repeat(31) + '20' + '00'.repeat(31) + '04' + '6e6f7065' + '00'.repeat(28)
    // Even with transport-sounding text, a hex revert payload means the contract replied.
    expect(isTransportError({
      code: 'CALL_EXCEPTION',
      info: { error: { code: 3, message: 'timeout while executing', data: payload } },
    })).toBe(false)
    expect(isTransportError({ code: 'CALL_EXCEPTION', message: 'timeout', data: '0x08c379a0' })).toBe(false)
  })

  it('does not let a revert reason that says "limit reached" count as transport', () => {
    expect(isTransportError({
      code: 'CALL_EXCEPTION',
      message: 'execution reverted: supply limit reached',
      info: { error: { code: -32000, message: 'execution reverted: supply limit reached' } },
    })).toBe(false)
  })

  it('treats bad data, empty returns and an invalid opcode as the contract answering', async () => {
    expect(isTransportError({ code: 'BAD_DATA', shortMessage: 'could not decode result data' })).toBe(false)
    const opcode = await callOf(endpoint(() => ({ error: { code: -32000, message: 'invalid opcode: INVALID' } })))
    expect(isTransportError(opcode)).toBe(false)
  })

  it('does not guess: an unrecognised error is not transport', () => {
    // Misreading a permanently odd contract as transport would retry it first on
    // every run and stop the healer each time.
    expect(isTransportError(new Error('something unexpected'))).toBe(false)
    expect(isTransportError('boom')).toBe(false)
    expect(isTransportError(null)).toBe(false)
  })
})

describe('fetchTokenMetadata transportFailed', () => {
  const answers = {
    name: encode('name', 'Tether USD'), symbol: encode('symbol', 'USDT'),
    decimals: encode('decimals', 18), totalSupply: encode('totalSupply', 1n),
  }

  it('is set when any one field was throttled, and the rest still resolve', async () => {
    const { runner } = mockRunner({ ...answers, symbol: rateLimited() })
    const meta = await fetchTokenMetadata(runner, TOKEN, { sequential: true })
    expect(meta.transportFailed).toBe(true)
    expect(meta.name).toBe('Tether USD')
    expect(meta.symbol).toBeNull()
  })

  it('is set for a rate limit as a real provider reports it', async () => {
    const p = endpoint(() => ({ error: { code: -32005, message: 'method eth_call in batch triggered rate limit' } }))
    const meta = await fetchTokenMetadata(p, TOKEN)
    expect(meta).toMatchObject({ name: null, symbol: null, decimals: null, totalSupply: null, transportFailed: true })
  })

  it('is not set when the contract reverts or returns nothing', async () => {
    const reverting = await fetchTokenMetadata(mockRunner({ name: revert(), symbol: revert(), decimals: revert(), totalSupply: revert() }).runner, TOKEN)
    const empty = await fetchTokenMetadata(mockRunner({ name: '0x', symbol: '0x', decimals: '0x', totalSupply: '0x' }).runner, TOKEN)
    expect(reverting.transportFailed).toBe(false)
    expect(empty.transportFailed).toBe(false)
  })
})

describe('decideHeal', () => {
  const fetched = (over: Partial<FetchedTokenMetadata> = {}): FetchedTokenMetadata =>
    ({ ...meta(), transportFailed: false, ...over })
  const dark = { name: null, symbol: null, decimals: null, totalSupply: null }

  it('does not mark a rate-limited token tried, so the next tick retries it', () => {
    const step = decideHeal(row(), fetched({ ...dark, transportFailed: true }), 0)
    expect(step).toMatchObject({ patch: null, markTried: false, transportFailed: true })
  })

  it('marks a token tried when the contract reverted, and writes nothing', () => {
    const step = decideHeal(row(), fetched({ ...dark, transportFailed: false }), 0)
    expect(step).toMatchObject({ patch: null, markTried: true, transportFailed: false })
  })

  it('still writes what resolved on a partial transport failure, but retries the token', () => {
    const step = decideHeal(row(), fetched({ symbol: null, transportFailed: true }), 0)
    expect(step.patch).toMatchObject({ name: 'Tether USD' })
    expect(step.patch).not.toHaveProperty('symbol')
    expect(step.markTried).toBe(false)
  })

  it('treats a timed-out fetch (no result at all) as a transport failure', () => {
    expect(decideHeal(row(), null, 0)).toMatchObject({ patch: null, markTried: false, transportFailed: true })
  })

  it('stops after the streak limit of consecutive transport failures, and a real answer resets it', () => {
    const failing = fetched({ ...dark, transportFailed: true })
    let streak = 0
    const stops: boolean[] = []
    for (let i = 0; i < TRANSPORT_STREAK_LIMIT; i++) {
      const step = decideHeal(row(), failing, streak)
      streak = step.streak
      stops.push(step.stop)
    }
    expect(TRANSPORT_STREAK_LIMIT).toBe(3)
    expect(stops).toEqual([false, false, true])

    const answered = decideHeal(row(), fetched({ ...dark }), 2)
    expect(answered).toMatchObject({ streak: 0, stop: false })
    expect(decideHeal(row(), failing, answered.streak).stop).toBe(false)
  })
})

describe('decideHeal transport strikes', () => {
  const failing: FetchedTokenMetadata = { ...meta(), name: null, symbol: null, decimals: null, totalSupply: null, transportFailed: true }
  const answered: FetchedTokenMetadata = { ...failing, transportFailed: false }

  it('keeps retrying a token after the first and second transport failures', () => {
    expect(decideHeal(row(), failing, 0, 0)).toMatchObject({ markTried: false, strikes: 1 })
    expect(decideHeal(row(), failing, 0, 1)).toMatchObject({ markTried: false, strikes: 2 })
  })

  it('marks it tried like a revert after the strike limit, and starts the next window clean', () => {
    expect(TRANSPORT_STRIKE_LIMIT).toBe(3)
    const step = decideHeal(row(), failing, 0, TRANSPORT_STRIKE_LIMIT - 1)
    expect(step).toMatchObject({ markTried: true, transportFailed: true, strikes: 0 })
  })

  it('counts a timed-out fetch as a strike', () => {
    expect(decideHeal(row(), null, 0, 2)).toMatchObject({ markTried: true, strikes: 0 })
    expect(decideHeal(row(), null, 0, 0)).toMatchObject({ markTried: false, strikes: 1 })
  })

  it('forgets the strikes once the token is fetched without a transport failure', () => {
    expect(decideHeal(row(), answered, 0, 2)).toMatchObject({ markTried: true, strikes: 0 })
    expect(decideHeal(row(), { ...meta(), transportFailed: false }, 0, 2)).toMatchObject({ markTried: true, strikes: 0 })
  })

  it('still lets a poisoned token stop the run only until its strikes run out', async () => {
    // Three runs fail on the same head token: the third marks it tried, so the fourth skips it.
    let strikes = 0
    const tried = new Map<string, number>()
    const { fetchPage } = pageSourceOf([row()])
    for (let run = 0; run < TRANSPORT_STRIKE_LIMIT; run++) {
      const scan = await scanHealCandidates(fetchPage, null, tried, 1, { batchSize: 40, pageSize: 80 })
      expect(scan.taken).toHaveLength(1)
      const step = decideHeal(scan.taken[0].row, failing, 0, strikes)
      strikes = step.strikes
      if (step.markTried) tried.set(row().address, 1)
    }
    expect((await scanHealCandidates(fetchPage, null, tried, 2, { batchSize: 40, pageSize: 80 })).taken).toEqual([])
  })
})
