import { getWebProvider } from '@/lib/rpc'
import { formatGwei } from '@/lib/format'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdReserve } from '@/components/ads/AdReserve'
import type { Metadata } from 'next'
import { swallow } from '@/lib/observability'
import { confirmationWindow } from '@/lib/confirmation-window'
import { feeCard, GAS_TIER_BLOCKS, gasTiersNote, gasTiles } from '@/lib/gas-tiers'
import { fetchGasTiers, GAS_REVALIDATE_SECONDS } from '@/lib/gas-percentiles'
import { createPageCache } from '@/lib/page-cache'
import { queryGasTape } from '@/lib/gas-tape-query'
import { gasBasis, gasLegend, gasStats, gasStripTiles, gasSummary } from '@/lib/gas-tape'
import { TileStrip } from '@/components/tape/TileStrip'

// A literal, as Next requires; revalidate-parity.test.ts pins it to GAS_REVALIDATE_SECONDS, the TTL of both caches below.
export const revalidate = 45

export const metadata: Metadata = {
  title: `Gas Tracker`,
  description: `Live ${chainConfig.name} gas price tracker. Check current slow, standard, and fast gas fees in Gwei on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/gas' },
}

// The tape's one query, behind the data cache (module scope, so it is built once). A failure is swallowed
// OUTSIDE the cache: a rejection is never stored, and the page just draws without the strip.
const cachedTape = createPageCache('gas-tape', GAS_REVALIDATE_SECONDS, queryGasTape)

async function readTape() {
  try {
    return await cachedTape()
  } catch (e) {
    swallow('gas/tape', e)
    return null
  }
}

export default async function GasPage() {
  const tapeQuery = readTape()   // beside the RPC reads below; it never rejects
  // The tiers come from the indexed blocks (cached), the headline card from the node: start both together.
  let tiersFailed = false
  const tiersRead = fetchGasTiers().catch((e) => { swallow('gas/tiers', e); tiersFailed = true; return null })
  const provider = await getWebProvider()
  let gasPrice = 0n
  let baseFeePerGas: bigint | null = null
  try {
    const [feeData, block] = await Promise.all([provider.getFeeData(), provider.getBlock('latest')])
    gasPrice = feeData.gasPrice ?? 0n
    baseFeePerGas = block?.baseFeePerGas ?? null
  } catch (e) {
    swallow('gas/query', e)
    // RPC down — show zeros, page still renders
  }
  // Per-chain network floor. '0' means the chain enforces none.
  const MIN_GAS_PRICE = BigInt(chainConfig.minGasPriceWei)
  const hasGasFloor = MIN_GAS_PRICE > 0n
  const floorGwei = formatGwei(MIN_GAS_PRICE)

  const tiers = await tiersRead
  const tiles = gasTiles(tiers)
  const card  = feeCard(baseFeePerGas, gasPrice)

  const tapeRows = await tapeQuery
  const fillBasis = tapeRows && tapeRows.length > 0 ? gasBasis(tapeRows) : null

  return (
    <>
    <div className="max-w-7xl mx-auto px-4 pt-8">
      <BreadcrumbJsonLd items={[{ name: 'Gas Tracker' }]} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [
            { '@type': 'Question', name: `What is gas on ${chainConfig.name}?`, acceptedAnswer: { '@type': 'Answer', text: `Gas is the unit that measures the computational effort required to execute transactions on ${chainConfig.name}. Every transaction — from a simple transfer to a complex smart contract call — requires gas. Gas prices are denominated in Gwei (1 Gwei = 0.000000001 ${chainConfig.currency}).` } },
            { '@type': 'Question', name: `How are ${chainConfig.name} gas fees calculated?`, acceptedAnswer: { '@type': 'Answer', text: `Gas fees = Gas Used × Gas Price (in Gwei). ${chainConfig.features.hasEip1559 ? 'The base fee' : 'The gas price'} is set by the network based on demand. During high-traffic periods, gas prices increase. ${hasGasFloor ? `${chainConfig.name} has a low network minimum gas price of ${floorGwei} Gwei.` : ''}${chainConfig.features.hasEip1559 ? ` ${chainConfig.name} uses EIP-1559 with a base fee that adjusts dynamically plus an optional priority fee (tip) to validators.` : ''}` } },
            { '@type': 'Question', name: 'What is the difference between slow, standard, and fast gas?', acceptedAnswer: { '@type': 'Answer', text: `Slow, standard and fast are the 25th, 50th and 75th percentile of what transactions paid in the last ${GAS_TIER_BLOCKS} blocks: ${chainConfig.features.hasEip1559 ? "the priority fee (tip), added to the newest indexed block's base fee" : 'the gas price'}. Paying a higher percentile means paying more than more of those transactions did, which makes quick inclusion more likely.` } },
          ],
        }) }}
      />
      <div className="mb-5">
        <p className="k">{'// '}gas</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Gas Tracker</h1>
        <p className="mt-2 max-w-3xl text-sm text-ink2">
          {chainConfig.name} gas prices, refreshed every {GAS_REVALIDATE_SECONDS} seconds. Gas is the fee paid to validators for processing transactions — higher gas means faster confirmation.
          {hasGasFloor && ` ${chainConfig.name} maintains a low minimum gas price of ${floorGwei} Gwei with typical confirmation in ${confirmationWindow(chainConfig.blockTime)}.`}
          {chainConfig.features.hasEip1559 && ` ${chainConfig.name} gas fluctuates with network demand, using EIP-1559 base fee mechanics.`}
        </p>
      </div>
    </div>

    {tapeRows && fillBasis && (
      <TileStrip
        entry="last"
        tiles={gasStripTiles(tapeRows, fillBasis)}
        title={chainConfig.name}
        stats={gasStats(tapeRows, fillBasis)}
        label={`${chainConfig.name} latest ${tapeRows.length} blocks, width is transactions, fill is ${fillBasis === 'base-fee' ? 'base fee' : 'gas used'}`}
        legend={gasLegend(fillBasis)}
        summary={gasSummary(tapeRows, fillBasis)}
      />
    )}

    <div className={`max-w-7xl mx-auto px-4 pb-8${fillBasis ? ' pt-6' : ''}`}>
      <dl className="ledger [--cols:3] mb-2">
        {tiles.map(t => <Fact key={t.label} label={t.label} gwei={t.gwei} basis={t.basis} />)}
      </dl>
      <p className="mb-8 text-xs text-mut">{gasTiersNote(tiers, chainConfig.features.hasEip1559, tiersFailed)}</p>

      <AdReserve
        context="gas"
        placement="gas_top"
        className="mb-8"
      />

      <div className="mb-8 rounded-xl border border-hair bg-card p-6">
        <h2 className="mb-3 text-lg font-semibold tracking-[-0.02em] text-ink">Current {card.label}</h2>
        <p className="font-mono text-4xl font-semibold text-ink">
          {formatGwei(card.value)}
          <span className="ml-2 font-sans text-xl font-normal text-mut">Gwei</span>
        </p>
        {hasGasFloor && gasPrice < MIN_GAS_PRICE && gasPrice > 0n && (
          <p className="mt-1 text-xs text-mut">
            Gas price is below the {floorGwei} Gwei minimum; transactions under it are not included.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-hair bg-card p-4">
        <p className="text-sm text-ink2">
          The current {card.label} is fetched live from the {chainConfig.name} RPC; Slow, Standard and Fast come from the indexed blocks.
          {hasGasFloor
            ? ` ${chainConfig.name} has a low network minimum gas price of ${floorGwei} Gwei — validators will not include transactions below this threshold even if the quoted gas price is lower. Transactions are typically confirmed within 1-3 blocks (${confirmationWindow(chainConfig.blockTime)}).`
            : ` Transactions are typically confirmed within 1-3 blocks (${confirmationWindow(chainConfig.blockTime)}).`
          }
        </p>
      </div>
    </div>
    </>
  )
}

function Fact({ label, gwei, basis }: { label: string; gwei: string; basis: string }) {
  return (
    <div>
      <dt className="k">{label}</dt>
      <dd className="mt-1 break-words font-mono text-xl font-semibold text-ink">{gwei}</dd>
      <dd className="mt-0.5 text-xs text-mut">Gwei · {basis}</dd>
    </div>
  )
}
