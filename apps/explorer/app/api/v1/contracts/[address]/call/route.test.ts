import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AbiCoder, makeError } from 'ethers'

const h = vi.hoisted(() => ({ rows: [] as unknown[], perform: null as null | (() => Promise<unknown>) }))

vi.mock('@/lib/api-auth', () => ({
  authRequest: async () => ({ ok: true }),
  authFailure: () => new Response('denied', { status: 401 }),
}))
vi.mock('@/lib/db', async () => {
  const { schema } = await import('@altscan/db')
  const chain = { from: () => chain, where: async () => h.rows }
  return { schema, db: { select: () => chain } }
})
// A real AbstractProvider (so Contract's call path is the shipped ethers one)
// whose node answers with whatever h.perform throws.
vi.mock('@/lib/rpc', async () => {
  const { AbstractProvider, Network } = await import('ethers')
  class FakeProvider extends AbstractProvider {
    async _detectNetwork() { return Network.from(56) }
    async _perform<T>(): Promise<T> { return (await h.perform!()) as T }
  }
  return { getWebProvider: async () => new FakeProvider(Network.from(56)) }
})

const ADDR = '0x' + '12'.repeat(20)
const ABI = JSON.stringify([{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'a', type: 'address', internalType: 'address' }],
  outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
}])

const post = async () => {
  const { POST } = await import('./route')
  return POST(
    new Request(`http://x/api/v1/contracts/${ADDR}/call`, {
      method: 'POST',
      body: JSON.stringify({ functionName: 'balanceOf', args: [ADDR] }),
    }),
    { params: Promise.resolve({ address: ADDR }) },
  )
}

beforeEach(() => {
  h.rows = [{ address: ADDR, abi: ABI }]
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  // swallow() throttles repeats per tag
  ;(await import('@/lib/observability')).resetSwallowThrottle()
})

describe('POST /api/v1/contracts/:address/call errors', () => {
  // The anonymous caller must not be able to read the keyed web RPC URL back out
  // of a throttled or failing endpoint.
  it('does not return the RPC endpoint URL when the node fails', async () => {
    h.perform = async () => {
      throw makeError('server response 429', 'SERVER_ERROR', {
        request: {} as never,
        response: {} as never,
        info: { requestUrl: 'https://rpc.example/v2/SECRETKEY', responseBody: '', responseStatus: '429 Too Many Requests' },
      })
    }
    const res = await post()
    const text = await res.text()
    expect(text).not.toContain('SECRETKEY')
    expect(text).not.toContain('requestUrl')
    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toEqual({ error: 'Upstream RPC error' })
    // ... and neither did the server log
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('SECRETKEY')
  })

  it('still returns the revert reason for a call that reverts', async () => {
    // Error(string) revert data, which ethers decodes into the reason
    const data = '0x08c379a0' + AbiCoder.defaultAbiCoder().encode(['string'], ['ERC20: nope']).slice(2)
    h.perform = async () => {
      throw makeError('execution reverted', 'CALL_EXCEPTION', {
        action: 'call', data, reason: null, transaction: { to: ADDR, data: '0x' } as never,
        invocation: null, revert: null,
      })
    }
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'execution reverted: "ERC20: nope"' })
  })
})
