import { describe, expect, it, vi } from 'vitest'
import { MAX_RESPONSE_BYTES, probeRpc, validateRpcUrl } from './rpc-probe'

/** Fetch stub that answers per JSON-RPC method. */
function fetchStub(
  byMethod: Record<string, { status?: number; body: string; contentLength?: string; noBody?: boolean }>,
  seen?: RequestInit[],
): typeof fetch {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen?.push(init ?? {})
    const method = JSON.parse(String(init?.body)).method as string
    const reply = byMethod[method] ?? { status: 500, body: '{}' }
    const headers = { get: (k: string) => (k.toLowerCase() === 'content-length' ? (reply.contentLength ?? null) : null) }
    // Always a ReadableStream, like the real runtime — the probe deliberately
    // has no unbounded text() fallback, so a stub without a body would only
    // ever exercise the empty-body path.
    const body = reply.noBody
      ? undefined
      : {
          getReader: () => {
            // Two chunks so the running byte cap is exercised mid-read rather
            // than only at the end.
            const chunks = [reply.body.slice(0, 8), reply.body.slice(8)].filter((c) => c.length > 0)
            let i = 0
            return {
              read: async () =>
                i < chunks.length
                  ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
                  : { done: true, value: undefined },
              cancel: async () => {},
              releaseLock: () => {},
            }
          },
        }
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, headers, body }
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

  it('refuses hosts the probe must never dial', () => {
    for (const bad of [
      'https://localhost:8545',
      'https://LOCALHOST/rpc',
      'https://api.localhost/rpc',
      'https://db.internal/rpc',
      'https://printer.local/rpc',
      'https://127.0.0.1:8545',
      'https://169.254.169.254/latest/meta-data', // cloud metadata
      'https://10.0.0.5/rpc',
      'https://192.168.1.1/rpc',
      'https://[::1]:8545',
      'https://[fd00::1]/rpc',
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

  it('rejects on content-length before reading a single byte of the body', async () => {
    const lying = {
      body: '{"result":"0x38"}',
      contentLength: String(MAX_RESPONSE_BYTES + 1),
    }
    const r = await probeRpc('https://x.test', 56, fetchStub({ eth_chainId: lying, eth_blockNumber: lying }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('too large')
  })

  it('caps a streamed body that exceeds the limit mid-read', async () => {
    const huge = { body: 'a'.repeat(MAX_RESPONSE_BYTES + 100) }
    const r = await probeRpc('https://x.test', 56, fetchStub({ eth_chainId: huge, eth_blockNumber: huge }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('too large')
  })

  it('reads a normal streamed body', async () => {
    const ok38 = { body: JSON.stringify({ result: '0x38' }) }
    const r = await probeRpc('https://x.test', 56, fetchStub({ eth_chainId: ok38, eth_blockNumber: ok38 }))
    expect(r.ok).toBe(true)
    expect(r.chainId).toBe(56)
  })

  it('does not follow redirects', async () => {
    const seen: RequestInit[] = []
    const redirect = { status: 302, body: '' }
    const r = await probeRpc(
      'https://x.test',
      56,
      fetchStub({ eth_chainId: redirect, eth_blockNumber: redirect }, seen),
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('redirected')
    expect(seen[0]?.redirect).toBe('manual')
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
