import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GasTiers } from '@/lib/gas-tiers'

// /gas: Slow / Standard / Fast are percentiles of what recent transactions paid (lib/gas-tiers), read from the
// indexed blocks. The headline card still comes from the node. Nothing here touches a network or a database.
const h = vi.hoisted(() => ({ tiers: vi.fn() }))
vi.mock('@/lib/gas-percentiles', () => ({ fetchGasTiers: h.tiers, GAS_REVALIDATE_SECONDS: 45 }))
vi.mock('@/lib/rpc', () => ({
  getWebProvider: async () => ({
    getFeeData: async () => ({ gasPrice: 50_000_000n }),
    getBlock: async () => ({ baseFeePerGas: 0n }),
  }),
}))
vi.mock('@/components/ads/AdReserve', () => ({ AdReserve: () => null }))   // async in production; an empty box here

// The page reads its chain from the environment when '@/lib/chain' loads, so each render imports it fresh.
const html = async () => {
  vi.resetModules()
  const { default: GasPage } = await import('./page')
  return renderToStaticMarkup(await GasPage())
}
const text = async () => (await html()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const BNB: GasTiers = { slow: '50000000', standard: '55000000', fast: '84158933', baseFee: null }

beforeEach(() => { h.tiers.mockReset() })
afterEach(() => vi.unstubAllEnvs())

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
    expect(t).toContain('Not enough recent transactions.')
    expect(t).not.toContain('Not available right now.')
    expect(t).toContain('from the last 20 blocks')
  })

  it('a failed read is the same "—", not a crash and not a number', async () => {
    h.tiers.mockRejectedValue(new Error('query timeout'))
    const t = await text()
    expect(t).toMatch(/Slow — Gwei/)
    expect(t).toContain('Not available right now.')
    expect(t).not.toContain('Not enough recent transactions.')
  })

  it('does not claim to update every block: tiles and page refresh every 45 seconds', async () => {
    h.tiers.mockResolvedValue(BNB)
    const t = await text()
    expect(t).not.toMatch(/updated every block/i)
    expect(t).toMatch(/gas prices, refreshed every 45 seconds/)
  })

  it('the headline card is still the node\'s reading', async () => {
    h.tiers.mockResolvedValue(BNB)
    expect(await text()).toMatch(/Current Gas Price 0\.05 Gwei/)
  })
})

describe('/gas tiers on Ethereum', () => {
  const ETH: GasTiers = { slow: '1000000000', standard: '2000000000', fast: '5000000000', baseFee: '10000000000' }

  it('shows base fee + tip per tier, and says the tip is the percentile', async () => {
    vi.stubEnv('CHAIN', 'eth')
    h.tiers.mockResolvedValue(ETH)
    const t = await text()
    expect(t).toMatch(/Slow 11 Gwei · base 10 \+ tip 1/)
    expect(t).toMatch(/Standard 12 Gwei · base 10 \+ tip 2/)
    expect(t).toMatch(/Fast 15 Gwei · base 10 \+ tip 5/)
    expect(t).toMatch(/base fee plus the priority fee \(tip\) paid by transactions from the last 20 blocks/)
    expect(t).not.toMatch(/10%|30%/)
  })

  it('with no data it is "—" and still says what the tiers would be', async () => {
    vi.stubEnv('CHAIN', 'eth')
    h.tiers.mockResolvedValue(null)
    const t = await text()
    expect(t).toMatch(/Slow — Gwei · 25th percentile/)
    expect(t).toMatch(/Not enough recent transactions\. The newest block(?:'|&#x27;)s base fee plus the priority fee/)
  })
})
