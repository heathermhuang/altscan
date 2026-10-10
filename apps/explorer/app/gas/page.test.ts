import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GasTiers } from '@/lib/gas-tiers'

// /gas: Slow / Standard / Fast are percentiles of what recent transactions paid (lib/gas-tiers), read from the
// indexed blocks. The headline card still comes from the node. Nothing here touches a network or a database.
const h = vi.hoisted(() => ({ tiers: vi.fn() }))
vi.mock('@/lib/gas-percentiles', () => ({ fetchGasTiers: h.tiers }))
vi.mock('@/lib/rpc', () => ({
  getWebProvider: async () => ({
    getFeeData: async () => ({ gasPrice: 50_000_000n }),
    getBlock: async () => ({ baseFeePerGas: 0n }),
  }),
}))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))   // async in production; an empty box here

import GasPage from './page'

const html = async () => renderToStaticMarkup(await GasPage())
const text = async () => (await html()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const BNB: GasTiers = { slow: '50000000', standard: '55000000', fast: '84158933', baseFee: null }

beforeEach(() => { h.tiers.mockReset() })

describe('/gas tiers', () => {
  it('shows the percentile gas prices, labelled "from the last 20 blocks"', async () => {
    h.tiers.mockResolvedValue(BNB)
    const t = await text()
    expect(t).toMatch(/Slow 0\.05 Gwei · 25th percentile gas price/)
    expect(t).toMatch(/Standard 0\.055 Gwei · 50th percentile gas price/)
    expect(t).toMatch(/Fast 0\.0842 Gwei · 75th percentile gas price/)
    expect(t).toContain('from the last 20 blocks')
  })

  it('has no synthetic buffer left anywhere on the page, JSON-LD included', async () => {
    h.tiers.mockResolvedValue(BNB)
    expect(await html()).not.toMatch(/\+ ?10%|\+ ?30%|10% buffer|30% buffer|\(10%\)/)
  })

  it('shows "—" and still names the sample when there is nothing to base the tiers on', async () => {
    h.tiers.mockResolvedValue(null)
    const t = await text()
    expect(t.match(/Gwei · \d+th percentile/g)).toHaveLength(3)
    expect(t).toMatch(/Slow — Gwei/)
    expect(t).toContain('Not available right now.')
    expect(t).toContain('from the last 20 blocks')
  })

  it('a failed read is the same "—", not a crash and not a number', async () => {
    h.tiers.mockRejectedValue(new Error('query timeout'))
    const t = await text()
    expect(t).toMatch(/Slow — Gwei/)
    expect(t).toContain('Not available right now.')
  })

  it('the headline card is still the node\'s reading', async () => {
    h.tiers.mockResolvedValue(BNB)
    expect(await text()).toMatch(/Current Gas Price 0\.05 Gwei/)
  })
})
