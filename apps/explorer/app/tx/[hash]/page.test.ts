import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

// Mocks are hoisted. The db is a recorder: it hands back canned rows per table and remembers which
// tables were read, so "the base-fee lookup ran" is observable. Nothing here touches a network or a database.
const state = vi.hoisted(() => ({
  dbTx: null as Record<string, unknown> | null,
  blockRow: null as { baseFee: string | null } | null,
  internalRows: [] as unknown[],
  tokenRows: [] as unknown[],
  logRows: [] as unknown[],
  fetchedMeta: new Map<string, { symbol: string | null; decimals: number | null }>(),
  nativeUsd: null as number | null,
  tablesRead: [] as unknown[],
  fetchTxFromRpc: vi.fn(),
  fetchBlockFromRpc: vi.fn(),
}))

vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const rowsOf = (table: unknown) => {
    if (table === schema.transactions) return state.dbTx ? [state.dbTx] : []
    if (table === schema.blocks) return state.blockRow ? [state.blockRow] : []
    if (table === schema.internalTransactions) return state.internalRows
    if (table === schema.tokens) return state.tokenRows
    if (table === schema.logs) return state.logRows
    return []
  }
  // A drizzle query builder is a thenable with .catch; this one is the same shape.
  const query = (rows: unknown[]) => {
    const q = {
      where: () => q, orderBy: () => q, limit: () => q,
      then: (ok: (v: unknown[]) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, bad),
      catch: (bad: (e: unknown) => unknown) => Promise.resolve(rows).catch(bad),
    }
    return q
  }
  return {
    schema,
    db: { select: () => ({ from: (table: unknown) => { state.tablesRead.push(table); return query(rowsOf(table)) } }) },
  }
})
vi.mock('@/lib/rpc-fallback', () => ({ fetchTxFromRpc: state.fetchTxFromRpc, fetchBlockFromRpc: state.fetchBlockFromRpc }))
// Chain tip comes from the node, so the page never falls back to a MAX(blocks.number) read of its own.
vi.mock('@/lib/rpc', () => ({ getWebProvider: async () => ({ getBlockNumber: async () => 1_000_000 }) }))
vi.mock('@/lib/body-cache', () => ({ getTxBody: vi.fn(async () => null), fetchTxInputFromRpc: vi.fn(async () => null) }))
vi.mock('@/lib/tx-internal', async (orig) => {
  const m = await orig<typeof import('@/lib/tx-internal')>()
  return { ...m, selectTxInternals: vi.fn((...args: Parameters<typeof m.selectTxInternals>) => m.selectTxInternals(...args)) }
})
vi.mock('@/lib/token-metadata', async (orig) => ({
  ...(await orig<typeof import('@/lib/token-metadata')>()),
  fetchTokenMetadata: async () => state.fetchedMeta,
}))
vi.mock('@/lib/native-price', () => ({ fetchNativeUsd: async () => state.nativeUsd }))
vi.mock('@/lib/block-strip', () => ({ getBlockStrip: vi.fn(async () => null) }))
vi.mock('@/lib/observability', async (orig) => ({
  ...(await orig<typeof import('@/lib/observability')>()),
  swallow: vi.fn(),
  swallowed: <T,>(_tag: string, fallback: T) => () => fallback,
}))

import { schema } from '@/lib/db'
import { Badge } from '@/components/ui/Badge'
import { getBlockStrip } from '@/lib/block-strip'
import { selectTxInternals } from '@/lib/tx-internal'
import { fetchTxInputFromRpc, getTxBody } from '@/lib/body-cache'
import { CALLDATA_TRANSFER_LABEL, TRUNCATED_INPUT_NOTE } from '@/lib/tx-view'
import TxDetailPage from './page'

const HASH = '0x' + 'ab'.repeat(32)
const render = () => TxDetailPage({ params: Promise.resolve({ hash: HASH }) })

// Find an element by component type anywhere in the returned tree (function components are not called).
// The status Badge sits in a Fact's children, which this walks.
function find(node: ReactNode, type: unknown): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = find(n, type); if (f) return f } return null }
  const el = node as { type?: unknown; props?: { children?: ReactNode } }
  if (el.type === type) return el as { props: Record<string, unknown> }
  return find(el.props?.children, type)
}

const rpcTx = (over: Record<string, unknown>) => ({
  hash: HASH, blockNumber: 0, fromAddress: '0x' + '11'.repeat(20), toAddress: '0x' + '22'.repeat(20), value: '0',
  gas: 21_000n, gasPrice: '5000000000', gasUsed: 0n, input: '0x', status: true, pending: true,
  methodId: null, txIndex: 0, nonce: 1, txType: 2, timestamp: new Date('2026-10-10T00:00:00.000Z'), _fromRpc: true,
  ...over,
})
const indexedTx = () => ({
  hash: HASH, blockNumber: 777, fromAddress: '0x' + '11'.repeat(20), toAddress: '0x' + '22'.repeat(20), value: '0',
  gas: 21_000n, gasPrice: '5000000000', gasUsed: 21_000n, input: '0x', status: true, methodId: null, txIndex: 3,
  nonce: 1, txType: 2, timestamp: new Date('2026-10-10T00:00:00.000Z'), bodyPruned: false,
})

beforeEach(() => {
  state.dbTx = null; state.blockRow = null; state.internalRows = []; state.tokenRows = []; state.logRows = []; state.fetchedMeta = new Map(); state.nativeUsd = null; state.tablesRead = []
  state.fetchTxFromRpc.mockReset(); state.fetchBlockFromRpc.mockReset()
  state.fetchBlockFromRpc.mockResolvedValue(null)
  vi.stubGlobal('fetch', async () => ({ ok: false }))   // native price: every source "down", the page renders without USD
})

describe('/tx/[hash] base-fee lookup', () => {
  it('a pending tx that is in no block runs neither the blocks select nor fetchBlockFromRpc', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 0, pending: true }))
    await render()
    expect(state.tablesRead).not.toContain(schema.blocks)
    expect(state.fetchBlockFromRpc).not.toHaveBeenCalled()
  })

  it('a tx in a block reads the block row first, and asks the node only when the row has no base fee', async () => {
    state.dbTx = indexedTx()
    state.blockRow = { baseFee: '3000000000' }
    await render()
    expect(state.tablesRead).toContain(schema.blocks)
    expect(state.fetchBlockFromRpc).not.toHaveBeenCalled()

    state.tablesRead = []
    state.blockRow = null
    await render()
    expect(state.tablesRead).toContain(schema.blocks)
    expect(state.fetchBlockFromRpc).toHaveBeenCalledTimes(1)
    expect(state.fetchBlockFromRpc).toHaveBeenCalledWith(777)
  })

  it('a tx the node has put in a block but not yet receipted is still looked up: its block is real', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 778, pending: true }))
    await render()
    expect(state.tablesRead).toContain(schema.blocks)
    expect(state.fetchBlockFromRpc).toHaveBeenCalledWith(778)
  })
})

describe('/tx/[hash] status badge', () => {
  it('a pending tx wears the pending badge, not the plain default one', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 0, pending: true }))
    const badge = find(await render(), Badge)
    expect(badge?.props.variant).toBe('pending')
    expect(badge?.props.children).toBe('Pending')
  })

  it('success and failed keep their own badges', async () => {
    state.dbTx = { ...indexedTx(), status: true }
    expect(find(await render(), Badge)?.props.variant).toBe('success')
    state.dbTx = { ...indexedTx(), status: false }
    expect(find(await render(), Badge)?.props.variant).toBe('fail')
  })
})

// ---- position in block ---------------------------------------------------------------------------

// All the text under a node (function components are not called, so this is what the page itself wrote).
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf((node as { props?: { children?: ReactNode } }).props?.children)
}

function findAll(node: ReactNode, pred: (props: Record<string, unknown>) => boolean, out: Record<string, unknown>[] = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  const props = (node as { props?: Record<string, unknown> }).props
  if (props && pred(props)) out.push(props)
  findAll(props?.children as ReactNode, pred, out)
  return out
}

const stripOf = (indices: number[]) => ({ gasLimit: 30_000_000, txs: indices.map(i => ({ i, gas: 21_000, price: 5e9, ok: true })) })
const eyebrow = (tree: ReactNode) => textOf(findAll(tree, p => p.className === 'k')[0]?.children as ReactNode)
const positionRow = (tree: ReactNode) => findAll(tree, p => p.label === 'Position In Block')[0]?.value

describe('/tx/[hash] position in block', () => {
  it('says the same 1-based place in the eyebrow and the table, against one fixture', async () => {
    state.dbTx = { ...indexedTx(), txIndex: 25 }              // tx_index is 0-based: this is the 26th
    vi.mocked(getBlockStrip).mockResolvedValueOnce(stripOf(Array.from({ length: 75 }, (_, i) => i)))
    const tree = await render()
    expect(eyebrow(tree)).toContain('26th of 75 in block 777')
    expect(positionRow(tree)).toBe('26 of 75')
  })

  it('counts by the strip position, so both agree even where tx_index skips', async () => {
    state.dbTx = { ...indexedTx(), txIndex: 3 }                // indices 0,1,3,4: the 3rd of 4
    vi.mocked(getBlockStrip).mockResolvedValueOnce(stripOf([0, 1, 3, 4]))
    const tree = await render()
    expect(eyebrow(tree)).toContain('3rd of 4 in block 777')
    expect(positionRow(tree)).toBe('3 of 4')
  })

  it('without the block strip the table is still 1-based, with no total it cannot know', async () => {
    state.dbTx = { ...indexedTx(), txIndex: 3 }                // getBlockStrip is null by default
    const tree = await render()
    expect(eyebrow(tree)).not.toContain(' in block ')
    expect(positionRow(tree)).toBe('4')
  })

  it('a pending tx has no position', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 0, pending: true }))
    expect(positionRow(await render())).toBeUndefined()
  })
})

// ---- internal transactions ------------------------------------------------------------------------

const internalRow = (i: number) => ({
  txHash: HASH, traceAddress: `0.${i}`, fromAddress: '0x' + '11'.repeat(20), toAddress: '0x' + '22'.repeat(20),
  value: '1', callType: 'call', blockNumber: 777, timestamp: new Date('2026-10-10T00:00:00.000Z'),
})
const internalRows = (n: number) => Array.from({ length: n }, (_, i) => internalRow(i))
const internalRowEls = (tree: ReactNode) => findAll(tree, p => typeof p.className === 'string' && p.className.includes('flex flex-wrap items-center gap-2 text-sm'))
const internalHeading = (tree: ReactNode) => textOf(findAll(tree, p => Array.isArray(p.children) && p.children[0] === 'Internal Transactions (')[0]?.children as ReactNode)

describe('/tx/[hash] internal transactions', () => {
  it('asks for this tx at its own block, so another height cannot answer', async () => {
    state.dbTx = indexedTx()
    vi.mocked(selectTxInternals).mockClear()
    await render()
    expect(selectTxInternals).toHaveBeenCalledWith(expect.anything(), HASH, 777)
  })

  it('lists 100 and says there are more when a 101st row came back', async () => {
    state.dbTx = indexedTx()
    state.internalRows = internalRows(101)
    const tree = await render()
    expect(internalRowEls(tree)).toHaveLength(100)
    expect(internalHeading(tree)).toBe('Internal Transactions (100+)')
    expect(textOf(tree)).toContain('Showing the first 100 internal transactions')
  })

  it('counts exactly, with no note, at or under 100', async () => {
    state.dbTx = indexedTx()
    state.internalRows = internalRows(100)
    const tree = await render()
    expect(internalRowEls(tree)).toHaveLength(100)
    expect(internalHeading(tree)).toBe('Internal Transactions (100)')
    expect(textOf(tree)).not.toContain('Showing the first')
  })

  it('draws nothing for a tx with none', async () => {
    state.dbTx = indexedTx()
    expect(textOf(await render())).not.toContain('Internal Transactions')
  })
})

// ---- a token transfer decoded from calldata ----------------------------------------------------------

describe('/tx/[hash] transfer(address,uint256) calldata fallback', () => {
  const TOKEN = '0x' + '55'.repeat(20)
  const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
  const transferCalldata = '0xa9059cbb' + word('0x' + '33'.repeat(20)) + word('1000')
  // The node served the tx (so its input) but its receipt/logs could not be refetched: getTxBody -> null.
  const viaRpc = (over: Record<string, unknown> = {}) => state.fetchTxFromRpc.mockResolvedValue(
    rpcTx({ blockNumber: 500, pending: false, status: true, toAddress: TOKEN, methodId: '0xa9059cbb', input: transferCalldata, ...over }))
  const findEl = (node: ReactNode, pred: (props: Record<string, unknown>) => boolean): { type: unknown; props: Record<string, unknown> } | null => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const n of node) { const f = findEl(n, pred); if (f) return f } return null }
    const el = node as { type?: unknown; props?: Record<string, unknown> }
    if (el.props && pred(el.props)) return el as { type: unknown; props: Record<string, unknown> }
    return findEl(el.props?.children as ReactNode, pred)
  }
  const calldataRow = (tree: ReactNode) => findEl(tree, p => (p.t as { unverified?: boolean } | undefined)?.unverified === true)
  const anyTransferRow = (tree: ReactNode) => findEl(tree, p => typeof p.t === 'object' && p.t !== null)

  beforeEach(() => { vi.mocked(getTxBody).mockReset().mockResolvedValue(null) })

  it('shows the row for a succeeded tx whose logs could not be read, and labels it unverified', async () => {
    viaRpc()
    const row = calldataRow(await render())
    expect(row).not.toBeNull()
    expect(row!.props.t).toMatchObject({ tokenAddress: TOKEN, toAddress: '0x' + '33'.repeat(20), value: '4096' })
    // The row component writes the label itself: render it.
    const Row = row!.type as (props: Record<string, unknown>) => ReactNode
    expect(textOf(Row(row!.props))).toContain(CALLDATA_TRANSFER_LABEL)
  })

  it('shows none for a failed tx: it moved nothing', async () => {
    viaRpc({ status: false })
    expect(anyTransferRow(await render())).toBeNull()
  })

  it('shows none for a pending tx: it has not run', async () => {
    viaRpc({ pending: true, blockNumber: 0 })
    expect(anyTransferRow(await render())).toBeNull()
  })

  it('shows none when the logs were read and held no Transfer (an empty receipt is an answer)', async () => {
    viaRpc()
    vi.mocked(getTxBody).mockResolvedValue({ input: transferCalldata, logs: [] })
    expect(anyTransferRow(await render())).toBeNull()
  })

  it('shows none for an indexed tx whose logs are local and hold no Transfer', async () => {
    state.dbTx = { ...indexedTx(), toAddress: TOKEN, methodId: '0xa9059cbb', input: transferCalldata }
    expect(anyTransferRow(await render())).toBeNull()
  })
})

// ---- USD figures --------------------------------------------------------------------------------------

describe('/tx/[hash] USD figures', () => {
  const sub = (tree: ReactNode, label: string) => findAll(tree, p => p.label === label)[0]?.sub

  it('says the Value and Fee figures are at the current price, not the price when the tx ran', async () => {
    state.nativeUsd = 600
    state.dbTx = { ...indexedTx(), value: '2000000000000000000.000000000000000000', gas: 21_000n, gasUsed: 21_000n, gasPrice: '5000000000' }
    const tree = await render()
    expect(sub(tree, 'Value')).toBe('$1,200.00 at current price')
    expect(sub(tree, 'Fee')).toBe('$0.06 at current price')
  })

  it('prints no USD figure at all without a price', async () => {
    state.dbTx = indexedTx()
    const tree = await render()
    expect(sub(tree, 'Value')).toBeUndefined()
    expect(sub(tree, 'Fee')).toBeUndefined()
  })
})

// ---- an input the indexer cut ---------------------------------------------------------------------------

describe('/tx/[hash] input the index stores cut at 500 characters', () => {
  const stored = '0x' + 'ab'.repeat(249)              // what the indexer keeps of a longer input
  const full = stored + 'cd'.repeat(300)
  const hexShown = (tree: ReactNode) => findAll(tree, p => typeof p.className === 'string' && p.className.includes('whitespace-pre-wrap') && typeof p.children === 'string').map(p => p.children)[0]

  beforeEach(() => { vi.mocked(fetchTxInputFromRpc).mockReset().mockResolvedValue(null) })

  it('shows the full input from the node in place of the stored prefix, with no cut-off note', async () => {
    state.dbTx = { ...indexedTx(), input: stored, methodId: '0xabababab' }
    vi.mocked(fetchTxInputFromRpc).mockResolvedValue(full)
    const tree = await render()
    expect(fetchTxInputFromRpc).toHaveBeenCalledWith(HASH)
    expect(hexShown(tree)).toBe(full)
    expect(textOf(tree)).not.toContain(TRUNCATED_INPUT_NOTE)
  })

  it('shows the stored prefix and says it is cut when the node cannot be asked', async () => {
    state.dbTx = { ...indexedTx(), input: stored, methodId: '0xabababab' }
    const tree = await render()
    expect(hexShown(tree)).toBe(stored)
    expect(textOf(tree)).toContain(TRUNCATED_INPUT_NOTE)
  })

  it('does not ask the node, or add a note, for an input stored whole', async () => {
    state.dbTx = { ...indexedTx(), input: '0xa9059cbb' + '00'.repeat(64), methodId: '0xa9059cbb' }
    const tree = await render()
    expect(fetchTxInputFromRpc).not.toHaveBeenCalled()
    expect(textOf(tree)).not.toContain(TRUNCATED_INPUT_NOTE)
  })

  it('leaves the pruned and node-served views to the body refetch they already do', async () => {
    state.dbTx = { ...indexedTx(), input: '0x', bodyPruned: true }
    await render()
    state.dbTx = null
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 500, pending: false, input: full, methodId: '0xabababab' }))
    const tree = await render()
    expect(fetchTxInputFromRpc).not.toHaveBeenCalled()
    expect(hexShown(tree)).toBe(full)
    expect(textOf(tree)).not.toContain(TRUNCATED_INPUT_NOTE)
  })
})

// ---- a refetched receipt with thousands of logs -----------------------------------------------------------

describe('/tx/[hash] logs from the refetched body', () => {
  // A receipt with 5,003 logs rendered every one of them: a 16 MB page that took 8 s and was too big to cache.
  const TOKEN = '0x' + '55'.repeat(20)
  const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
  const transferLog = (i: number) => ({
    address: TOKEN, topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    topic1: '0x' + word('0x' + '22'.repeat(20)), topic2: '0x' + word('0x' + '33'.repeat(20)), topic3: null,
    data: '0x' + word('1000'), logIndex: i,
  })
  const bodyWith = (n: number) => vi.mocked(getTxBody).mockResolvedValue({ input: '0x', logs: Array.from({ length: n }, (_, i) => transferLog(i)) })
  const heading = (tree: ReactNode, title: string) =>
    textOf(findAll(tree, p => Array.isArray(p.children) && p.children[0] === `${title} (`)[0]?.children as ReactNode)
  const logEls = (tree: ReactNode) => findAll(tree, p => typeof p.className === 'string' && p.className.startsWith('overflow-auto rounded-lg border border-hair bg-canvas p-3'))

  beforeEach(() => { vi.mocked(getTxBody).mockReset().mockResolvedValue(null) })

  it('lists 50 logs of a pruned tx, as the local view does, however many the receipt holds', async () => {
    state.dbTx = { ...indexedTx(), bodyPruned: true }
    bodyWith(60)
    const tree = await render()
    expect(logEls(tree)).toHaveLength(50)
    expect(heading(tree, 'Event Logs')).toBe('Event Logs (50)')
  })

  it('lists 25 of the transfers it decodes for a node-served tx and says there are more', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 500, pending: false, status: true }))
    bodyWith(60)
    const tree = await render()
    expect(heading(tree, 'Token Transfers')).toBe('Token Transfers (25+)')
    expect(textOf(tree)).toContain('Showing the first 25 token transfers')
  })

  it('decodes transfers from the whole receipt, not only the 50 logs it lists', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 500, pending: false, status: true }))
    const otherEvent = (i: number) => ({ ...transferLog(i), topic0: '0x' + 'ee'.repeat(32) })
    vi.mocked(getTxBody).mockResolvedValue({
      input: '0x', logs: [...Array.from({ length: 60 }, (_, i) => otherEvent(i)), ...Array.from({ length: 30 }, (_, i) => transferLog(60 + i))],
    })
    const tree = await render()
    expect(logEls(tree)).toHaveLength(50)
    expect(heading(tree, 'Token Transfers')).toBe('Token Transfers (25+)')
  })

  it('lists them all, with no note, at or under 25', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 500, pending: false, status: true }))
    bodyWith(25)
    const tree = await render()
    expect(heading(tree, 'Token Transfers')).toBe('Token Transfers (25)')
    expect(textOf(tree)).not.toContain('Showing the first')
  })
})

// ---- the headline of an approve, and of a transfer of a token with unknown decimals ------------------------

describe('/tx/[hash] headline', () => {
  const TOKEN = '0x' + '55'.repeat(20)
  const SPENDER = '0x' + '11'.repeat(20)
  const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
  const headline = (tree: ReactNode) => textOf(findAll(tree, p => typeof p.className === 'string' && p.className.includes('leading-[1.1]'))[0]?.children as ReactNode)
  const approve = (amount: bigint) => '0x095ea7b3' + word(SPENDER) + word(amount.toString(16))
  const approveTx = (over: Record<string, unknown> = {}) => ({
    ...indexedTx(), toAddress: TOKEN, methodId: '0x095ea7b3', input: approve(2n ** 256n - 1n), ...over,
  })
  // The ERC-20 Approval(owner, spender, value) the token emitted: what proves the amount is an amount.
  const erc20Approval = {
    address: TOKEN, topic0: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    topic1: '0x' + word('22'.repeat(20)), topic2: '0x' + word(SPENDER), topic3: null, data: '0x' + 'f'.repeat(64),
  }

  it('names the spender from the calldata and the token by its symbol, not the token as the spender', async () => {
    state.dbTx = approveTx()
    state.logRows = [erc20Approval]
    state.tokenRows = [{ address: TOKEN, symbol: 'ACME', decimals: 18 }]
    expect(headline(await render())).toBe(`Approved ${SPENDER.slice(0, 12)}… to spend unlimited ACME`)
  })

  it('reads no amount into an approve whose logs prove no ERC-20 Approval (ERC-721 shares the selector)', async () => {
    state.dbTx = approveTx({ input: approve(0n) })
    state.logRows = [{ ...erc20Approval, topic3: '0x' + word('0') }]
    state.tokenRows = [{ address: TOKEN, symbol: 'PUNK', decimals: 0 }]
    expect(headline(await render())).toBe(`Approved ${SPENDER.slice(0, 12)}… on PUNK`)
  })

  it('names the token only generically when its symbol is the indexer placeholder', async () => {
    state.dbTx = approveTx()
    state.logRows = [erc20Approval]
    state.tokenRows = [{ address: TOKEN, symbol: '???', decimals: 18 }]
    expect(headline(await render())).toBe(`Approved ${SPENDER.slice(0, 12)}… to spend unlimited tokens`)
  })

  it('does not name the token contract as the spender when the calldata is not available', async () => {
    state.dbTx = approveTx({ input: '0x', bodyPruned: true })
    expect(headline(await render())).toBe('Approved a token allowance')
  })

  it('reads the amount of a transfer of a token whose decimals nothing answered as ?, not as 18-decimal', async () => {
    state.fetchTxFromRpc.mockResolvedValue(rpcTx({ blockNumber: 500, pending: false, status: true, toAddress: TOKEN, methodId: '0xa9059cbb', input: '0xa9059cbb' }))
    vi.mocked(getTxBody).mockResolvedValue({
      input: '0xa9059cbb',
      logs: [{
        address: TOKEN, topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        topic1: '0x' + word('0x' + '22'.repeat(20)), topic2: '0x' + word('0x' + '33'.repeat(20)), topic3: null, data: '0x' + word('1000'), logIndex: 0,
      }],
    })
    state.fetchedMeta = new Map([[TOKEN, { symbol: 'ACME', decimals: null }]])
    expect(headline(await render())).toBe(`Transferred ? ACME to ${'0x' + '3'.repeat(10)}…`)
  })
})
