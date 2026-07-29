import { describe, expect, it, vi } from 'vitest'
import { MAX_RESPONSE_BYTES, probeRpc, validateRpcUrl } from './rpc-probe'

/** Fetch stub that answers per JSON-RPC method. */
function fetchStub(byMethod: Record<string, { status?: number; body: string }>): typeof fetch {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const method = JSON.parse(String(init?.body)).method as string
    const reply = byMethod[method] ?? { status: 500, body: '{}' }
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      text: async () => reply.body,
    }
  }) as unknown as typeof fetch
}

const ok = (result: string) => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })
const BSC = { eth_chainId: ok('0x38'), eth_blockNumber: ok('0x2fd1a3c') } // 56 / 50140732

describe('validateRpcUrl', () => {
  it('accepts https and rejects everything else', () => {
    expect(validateRpcUrl('https://bsc-dataseed.binance.org')).toBe('https://bsc-dataseed.binance.org')
    for (const bad of [
      'http://bsc-dataseed.binance.org',
      'wss://x.test',
      '//x.test',
      '/relative',
      'javascript:alert(1)',
      'https://evil.test\\@good.test',
      'https://evil.test\nHost: x',
      '',
      null,
      undefined,
      42,
      { url: 'https://x.test' },
    ]) {
      expect(validateRpcUrl(bad)).toBeNull()
    }
  })
})

describe('probeRpc', () => {
  it('reports chainId, block, and a match against the expected id', async () => {
    const r = await probeRpc('https://x.test', 56, fetchStub(BSC))
    expect(r.ok).toBe(true)
    expect(r.chainId).toBe(56)
    expect(r.blockNumber).toBe(0x2fd1a3c)
    expect(r.chainIdMatches).toBe(true)
    expect(typeof r.latencyMs).toBe('number')
  })

  it('flags a chain-id MISMATCH — an ETH endpoint on a BNB explorer', async () => {
    const eth = { eth_chainId: ok('0x1'), eth_blockNumber: ok('0x15d0f8a') }
    const r = await probeRpc('https://x.test', 56, fetchStub(eth))
    expect(r.ok).toBe(true)
    expect(r.chainId).toBe(1)
    expect(r.expectedChainId).toBe(56)
    expect(r.chainIdMatches).toBe(false)
  })

  it('returns chainIdMatches null when the expected id is unknown', async () => {
    const r = await probeRpc('https://x.test', null, fetchStub(BSC))
    expect(r.ok).toBe(true)
    expect(r.chainIdMatches).toBeNull()
  })

  it('still succeeds when only eth_blockNumber fails', async () => {
    const partial = { eth_chainId: ok('0x38'), eth_blockNumber: { status: 429, body: '' } }
    const r = await probeRpc('https://x.test', 56, fetchStub(partial))
    expect(r.ok).toBe(true)
    expect(r.chainId).toBe(56)
    expect(r.blockNumber).toBeNull()
    expect(r.blockNumberError).toContain('429')
  })

  it('surfaces upstream failures without leaking the response body', async () => {
    const secret = 'SECRET-INTERNAL-TOKEN'
    const r = await probeRpc('https://x.test', 56, fetchStub({ eth_chainId: { status: 403, body: secret } }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('endpoint returned HTTP 403')
    expect(JSON.stringify(r)).not.toContain(secret)
  })

  it('rejects a non-JSON response', async () => {
    const html = { eth_chainId: { body: '<html>login</html>' }, eth_blockNumber: { body: '<html/>' } }
    const r = await probeRpc('https://x.test', 56, fetchStub(html))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('endpoint did not return JSON')
  })

  it('refuses to read an oversized body', async () => {
    const huge = { body: JSON.stringify({ result: '0x38', pad: 'a'.repeat(MAX_RESPONSE_BYTES) }) }
    const r = await probeRpc('https://x.test', 56, fetchStub({ eth_chainId: huge, eth_blockNumber: huge }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('too large')
  })

  it('surfaces a JSON-RPC error object', async () => {
    const err = { body: JSON.stringify({ error: { message: 'method not supported' } }) }
    const r = await probeRpc('https://x.test', 56, fetchStub({ eth_chainId: err, eth_blockNumber: err }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('method not supported')
  })

  it('rejects a malformed chain id rather than parsing garbage', async () => {
    for (const result of ['0x12zz', 'not-hex', '0x']) {
      const r = await probeRpc('https://x.test', 56, fetchStub({ eth_chainId: { body: JSON.stringify({ result }) } }))
      expect(r.ok).toBe(false)
      expect(r.error).toBe('eth_chainId was not a hex number')
    }
  })

  it('reports a transport failure as unreachable', async () => {
    const boom = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND internal.corp')
    }) as unknown as typeof fetch
    const r = await probeRpc('https://x.test', 56, boom)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('could not reach endpoint')
    expect(r.error).not.toContain('internal.corp')
  })

  it('reports an aborted probe as a timeout', async () => {
    const abort = vi.fn(async () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }) as unknown as typeof fetch
    const r = await probeRpc('https://x.test', 56, abort)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('timed out')
  })
})
