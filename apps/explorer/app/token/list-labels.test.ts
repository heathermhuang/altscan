import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const token = (address: string, symbol: string, holderCount: number) =>
  ({ address, symbol, name: symbol, type: 'BEP20', decimals: 18, totalSupply: '1000000000000000000000', holderCount })

vi.mock('@/lib/db', () => {
  const rows = [token('0x55d398326f99059ff775485246999027b3197955', 'USDT', 835871)]
  const q: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit']) q[m] = () => q
  q.then = (resolve: (r: unknown) => unknown) => resolve(rows)
  return { db: { select: () => q }, schema: { tokens: {} } }
})

// The /token list ranks by tokens.holder_count: the explorer's own count, so the column says so.
describe('/token list holder label', () => {
  it('heads the holders column "Indexed holders", with the tooltip', async () => {
    const { default: Page } = await import('./page')
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }))
    expect(html).toMatch(/<th scope="col" title="A snapshot from this explorer[^"]*">Indexed holders<\/th>/i)
    expect(html).not.toContain('>Holders</th>')
    expect(html).toContain('835,871')
  })
})
