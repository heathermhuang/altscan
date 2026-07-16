import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTxBodyFromRpc, getTxBody } from './body-cache'
import { getProvider } from './rpc'
import { kvGet, kvSet } from '@altscan/explorer-core'
import { serializeTxBody } from './body-cache-serde'

vi.mock('./rpc', () => ({ getProvider: vi.fn() }))
vi.mock('@altscan/explorer-core', () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
}))

const HASH = '0x' + 'ab'.repeat(32)

const rpcLog = {
  address: '0xAbCdEf0000000000000000000000000000000001',
  topics: ['0xt0', '0xt1'],
  data: '0x01',
  index: 3,
}

function mockProvider(opts: { tx?: unknown; receipt?: unknown; throws?: boolean }) {
  vi.mocked(getProvider).mockReturnValue({
    getTransaction: vi.fn(async () => {
      if (opts.throws) throw new Error('rpc down')
      return opts.tx ?? null
    }),
    getTransactionReceipt: vi.fn(async () => {
      if (opts.throws) throw new Error('rpc down')
      return opts.receipt ?? null
    }),
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(kvGet).mockResolvedValue(null)
})

describe('fetchTxBodyFromRpc', () => {
  it('returns input + normalized logs when tx AND receipt are present', async () => {
    mockProvider({ tx: { data: '0xdeadbeef' }, receipt: { logs: [rpcLog] } })
    expect(await fetchTxBodyFromRpc(HASH)).toEqual({
      input: '0xdeadbeef',
      logs: [{
        address: '0xabcdef0000000000000000000000000000000001',
        topic0: '0xt0', topic1: '0xt1', topic2: null, topic3: null,
        data: '0x01', logIndex: 3,
      }],
    })
  })

  it('a missing receipt is a FAILURE, not an empty-logs success', async () => {
    mockProvider({ tx: { data: '0xdeadbeef' }, receipt: null })
    expect(await fetchTxBodyFromRpc(HASH)).toBeNull()
  })

  it('a missing tx is a failure even if the receipt is present', async () => {
    mockProvider({ tx: null, receipt: { logs: [rpcLog] } })
    expect(await fetchTxBodyFromRpc(HASH)).toBeNull()
  })

  it('returns null when the provider throws', async () => {
    mockProvider({ throws: true })
    expect(await fetchTxBodyFromRpc(HASH)).toBeNull()
  })
})

describe('getTxBody caching', () => {
  it('serves from cache without touching the provider', async () => {
    vi.mocked(kvGet).mockResolvedValue(serializeTxBody({ input: '0x01', logs: [] }))
    mockProvider({ throws: true })
    expect(await getTxBody(HASH)).toEqual({ input: '0x01', logs: [] })
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('caches a successful fetch', async () => {
    mockProvider({ tx: { data: '0xdeadbeef' }, receipt: { logs: [] } })
    const body = await getTxBody(HASH)
    expect(body?.input).toBe('0xdeadbeef')
    expect(kvSet).toHaveBeenCalledTimes(1)
  })

  it('never caches a partial/failed fetch (retry stays possible)', async () => {
    mockProvider({ tx: { data: '0xdeadbeef' }, receipt: null })
    expect(await getTxBody(HASH)).toBeNull()
    expect(kvSet).not.toHaveBeenCalled()
  })
})
