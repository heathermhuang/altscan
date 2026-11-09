import { describe, expect, it, vi } from 'vitest'
import { currentClientAdmission } from '@altscan/providers'

// The internal address routes run their provider calls charged to the client's IP bucket, per hour.
const h = vi.hoisted(() => ({ calls: [] as Array<[string, number | undefined, number | undefined]> }))
vi.mock('@/lib/api-rate-limit', () => ({
  checkRateLimit: async (key: string, max?: number, windowMs?: number) => { h.calls.push([key, max, windowMs]); return true },
  clientIpBucket: () => '2001:db8:1:2::/64',
}))

describe('asClient', () => {
  it('charges prov:<ip bucket>, 60 billed calls per hour, only when the adapter asks', async () => {
    const { asClient, PROVIDER_CALLS_PER_CLIENT_PER_HOUR } = await import('./internal-guard')
    expect(PROVIDER_CALLS_PER_CLIENT_PER_HOUR).toBe(60)
    const req = new Request('http://x/api/internal/address/0x1/history')
    await asClient(req, async () => 'cached: the adapter never asks')
    expect(h.calls).toEqual([])
    await asClient(req, async () => currentClientAdmission()!())
    expect(h.calls).toEqual([['prov:2001:db8:1:2::/64', 60, 60 * 60 * 1000]])
  })
})

describe('internal address routes', () => {
  it('make every provider call through asClient', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(__dirname, '../app/api/internal/address/[address]')
    const routes = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name, 'route.ts'))
    const src = routes.map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(src.match(/await provider\./g) ?? [], 'a provider call outside asClient').toEqual([])
    expect((src.match(/asClient\(_req, \(\) => provider\./g) ?? []).length).toBe(6)
  })
})
