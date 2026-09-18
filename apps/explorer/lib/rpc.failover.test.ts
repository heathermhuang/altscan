import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWebProvider } from './rpc'
import { getSetting } from './settings'

// rpc.test.ts mocks ethers to test the singleton and keying. These tests run
// the shipped getWebProvider() against local JSON-RPC endpoints with REAL ethers,
// because failover is ethers behaviour: #140's quorum-1 FallbackProvider passed a
// mocked constructor test while throwing the first endpoint's error without ever
// asking the next one.
vi.mock('./settings', () => ({ getSetting: vi.fn(async () => null) }))

type Mode = 'ok' | 'http408' | 'rpcError' | 'hang'
type Endpoint = { url: string; requests: string[] }

const servers: http.Server[] = []

/**
 * A local JSON-RPC endpoint. Chain-id and block-number probes are always
 * answered, like a node that is up but failing some requests; every other method
 * gets `result`, or misbehaves per `mode`. Records each request's method
 * ('BATCH' for a JSON-RPC array).
 */
async function endpoint(mode: Mode, result = '0x1'): Promise<Endpoint> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const msg = JSON.parse(body)
      requests.push(Array.isArray(msg) ? 'BATCH' : msg.method)
      const probe = !Array.isArray(msg) && ['eth_chainId', 'eth_blockNumber'].includes(msg.method)
      if (!probe && mode === 'hang') return
      if (!probe && mode === 'http408') {
        res.writeHead(408)
        return res.end('Request Timeout')
      }
      const reply = (m: { id: number; method: string }) =>
        m.method === 'eth_chainId' ? { jsonrpc: '2.0', id: m.id, result: '0x38' }
        : m.method === 'eth_blockNumber' ? { jsonrpc: '2.0', id: m.id, result: '0x100' }
        : mode === 'rpcError' ? { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'header not found' } }
        : { jsonrpc: '2.0', id: m.id, result }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(reply) : reply(msg)))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

/** Point the web provider at `eps`, in priority order, via the console override. */
function useEndpoints(...eps: Endpoint[]) {
  vi.mocked(getSetting).mockResolvedValue(
    { webRpcUrl: eps.map((e) => e.url).join(','), rpcTimeoutMs: 1000 } as never)
}

const ADDRS = ['11', '22', '33'].map((b) => '0x' + b.repeat(20))

beforeEach(() => {
  (globalThis as { __explorer_provider?: unknown }).__explorer_provider = null
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections()
    s.close(() => resolve())
  })))
})

describe('getWebProvider against real endpoints', () => {
  it('serves from the first endpoint without contacting the next while it is healthy', async () => {
    const a = await endpoint('ok', '0x1')
    const b = await endpoint('ok', '0x2')
    useEndpoints(a, b)
    expect(await (await getWebProvider()).getBalance(ADDRS[0])).toBe(1n)
    expect(b.requests).toEqual([])
  })

  it('fails over when the first endpoint answers HTTP 408', async () => {
    useEndpoints(await endpoint('http408'), await endpoint('ok', '0x2'))
    expect(await (await getWebProvider()).getBalance(ADDRS[0])).toBe(2n)
  })

  it('fails over when the first endpoint hangs past the timeout', async () => {
    useEndpoints(await endpoint('hang'), await endpoint('ok', '0x2'))
    expect(await (await getWebProvider()).getBalance(ADDRS[0])).toBe(2n)
  })

  // ethers reports ANY JSON-RPC error on eth_call as CALL_EXCEPTION, so a
  // rate-limit reply looks exactly like a revert. Failing over on both costs a
  // genuine revert one duplicate call.
  it('fails over on an eth_call error, which ethers reports as a revert', async () => {
    const word = '0x' + '2a'.padStart(64, '0')
    useEndpoints(await endpoint('rpcError'), await endpoint('ok', word))
    expect(await (await getWebProvider()).call({ to: ADDRS[0], data: '0x' })).toBe(word)
  })

  it("throws the first endpoint's error once every endpoint has failed", async () => {
    // The second endpoint hangs, so this also proves the timeout applies past the first.
    useEndpoints(await endpoint('http408'), await endpoint('hang'))
    await expect((await getWebProvider()).getBalance(ADDRS[0])).rejects.toMatchObject({ code: 'SERVER_ERROR' })
  })

  // drpc's free plan rejects any JSON-RPC batch over 3 with a 500 for the whole
  // batch, and this provider is a process-wide singleton shared by concurrent renders.
  it('never batches concurrent calls on any endpoint', async () => {
    const a = await endpoint('http408')
    const b = await endpoint('ok', '0x2')
    useEndpoints(a, b)
    const p = await getWebProvider()
    expect(await Promise.all(ADDRS.map((addr) => p.getBalance(addr)))).toEqual([2n, 2n, 2n])
    expect([...a.requests, ...b.requests]).not.toContain('BATCH')
  })

  it('sends one request per call, with no eth_chainId check before it', async () => {
    const a = await endpoint('ok')
    useEndpoints(a) // one url: what both web services run today
    const p = await getWebProvider()
    for (const addr of ADDRS) await p.getBalance(addr)
    expect(a.requests).toEqual(['eth_getBalance', 'eth_getBalance', 'eth_getBalance'])
  })
})
