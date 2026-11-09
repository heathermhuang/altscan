import { beforeEach, describe, expect, it, vi } from 'vitest'

// altscan.io's MCP calls share one 600/min service bucket. The Worker now sends each MCP client's HMAC'd id, so one
// client gets a sub-bucket, checked first, and cannot draw the whole shared bucket. The id counts only with the token.
const h = vi.hoisted(() => ({ keys: [] as Array<[string, number | undefined]>, deny: new Set<string>() }))
vi.mock('@altscan/explorer-core', () => ({
  checkRateLimit: async (key: string, max?: number) => { h.keys.push([key, max]); return !h.deny.has(key) },
  clientIpBucket: () => '203.0.113.9',
  clientIpFromHeaders: () => '203.0.113.9',
}))

const TOKEN = 's'.repeat(40)
const ID = 'a'.repeat(32)
const headers = (extra: Record<string, string>) => new Headers({ 'x-altscan-service-token': TOKEN, ...extra })

beforeEach(() => { h.keys = []; h.deny = new Set(); process.env.ALTSCAN_SERVICE_TOKEN = TOKEN })

describe('service-token calls: per-client sub-buckets', () => {
  it('a client id is charged its own bucket first, then the shared one', async () => {
    const { checkIpRateLimit } = await import('./api-rate-limit')
    expect(await checkIpRateLimit(headers({ 'x-altscan-service-client-id': ID }))).toBe(true)
    expect(h.keys).toEqual([[`service:altscan-mcp:client:${ID}`, 120], ['service:altscan-mcp', 600]])
  })

  it('a client over its own bucket is refused without touching the shared one', async () => {
    const { checkIpRateLimit } = await import('./api-rate-limit')
    h.deny.add(`service:altscan-mcp:client:${ID}`)
    expect(await checkIpRateLimit(headers({ 'x-altscan-service-client-id': ID }))).toBe(false)
    expect(h.keys.map((k) => k[0])).toEqual([`service:altscan-mcp:client:${ID}`])
  })

  it('no id, or a malformed one, is the shared bucket alone, as before', async () => {
    const { checkIpRateLimit } = await import('./api-rate-limit')
    await checkIpRateLimit(headers({}))
    await checkIpRateLimit(headers({ 'x-altscan-service-client-id': 'not-an-id' }))
    expect(h.keys).toEqual([['service:altscan-mcp', 600], ['service:altscan-mcp', 600]])
  })

  it('the status feed keeps its own bucket and ignores an id', async () => {
    const { checkIpRateLimit } = await import('./api-rate-limit')
    await checkIpRateLimit(headers({ 'x-altscan-service-client': 'status-feed', 'x-altscan-service-client-id': ID }))
    expect(h.keys).toEqual([['service:altscan-status-feed', 600]])
  })

  it('without a valid token an id means nothing: the per-IP bucket', async () => {
    const { checkIpRateLimit } = await import('./api-rate-limit')
    await checkIpRateLimit(new Headers({ 'x-altscan-service-client-id': ID }))
    expect(h.keys.map((k) => k[0])).toEqual(['203.0.113.9'])
  })
})
