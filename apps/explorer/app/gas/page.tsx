import { getWebProvider } from '@/lib/rpc'
import { formatGwei } from '@/lib/format'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { AdReserve } from '@/components/ads/AdReserve'
import type { Metadata } from 'next'
import { swallow } from '@/lib/observability'
import { confirmationWindow } from '@/lib/confirmation-window'

export const revalidate = 45

export const metadata: Metadata = {
  title: `Gas Tracker`,
  description: `Live ${chainConfig.name} gas price tracker. Check current slow, standard, and fast gas fees in Gwei on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/gas' },
}

export default async function GasPage() {
  const provider = await getWebProvider()
  let baseFee = 0n
  try {
    const feeData = await provider.getFeeData()
    baseFee = feeData.gasPrice ?? 0n
  } catch (e) {
    swallow('gas/query', e)
    // RPC down — show zeros, page still renders
  }
  // Per-chain network floor. '0' means the chain enforces none.
  const MIN_GAS_PRICE = BigInt(chainConfig.minGasPriceWei)
  const hasGasFloor = MIN_GAS_PRICE > 0n
  const floorGwei = formatGwei(MIN_GAS_PRICE)
  const effectiveGasPrice = baseFee > MIN_GAS_PRICE ? baseFee : (MIN_GAS_PRICE > 0n ? MIN_GAS_PRICE : baseFee)

  const slow     = effectiveGasPrice
  const standard = (effectiveGasPrice * 110n) / 100n
  const fast     = (effectiveGasPrice * 130n) / 100n

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Gas Tracker' }]} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [
            { '@type': 'Question', name: `What is gas on ${chainConfig.name}?`, acceptedAnswer: { '@type': 'Answer', text: `Gas is the unit that measures the computational effort required to execute transactions on ${chainConfig.name}. Every transaction — from a simple transfer to a complex smart contract call — requires gas. Gas prices are denominated in Gwei (1 Gwei = 0.000000001 ${chainConfig.currency}).` } },
            { '@type': 'Question', name: `How are ${chainConfig.name} gas fees calculated?`, acceptedAnswer: { '@type': 'Answer', text: `Gas fees = Gas Used × Gas Price (in Gwei). The base fee is set by the network based on demand. During high-traffic periods, gas prices increase. ${hasGasFloor ? `${chainConfig.name} has a low network minimum gas price of ${floorGwei} Gwei.` : ''}${chainConfig.features.hasEip1559 ? ` ${chainConfig.name} uses EIP-1559 with a base fee that adjusts dynamically plus an optional priority fee (tip) to validators.` : ''}` } },
            { '@type': 'Question', name: 'What is the difference between slow, standard, and fast gas?', acceptedAnswer: { '@type': 'Answer', text: 'Slow gas uses the base fee and may take longer to confirm. Standard gas adds a small buffer (10%) for reliable confirmation within a few blocks. Fast gas adds a 30% buffer for near-instant confirmation. Higher gas prices incentivize validators to include your transaction sooner.' } },
          ],
        }) }}
      />
      <div className="mb-5">
        <p className="k">{'// '}gas</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Gas Tracker</h1>
        <p className="mt-2 max-w-3xl text-sm text-ink2">
          Live {chainConfig.name} gas prices updated every block. Gas is the fee paid to validators for processing transactions — higher gas means faster confirmation.
          {hasGasFloor && ` ${chainConfig.name} maintains a low minimum gas price of ${floorGwei} Gwei with typical confirmation in 1-3 seconds.`}
          {chainConfig.features.hasEip1559 && ` ${chainConfig.name} gas fluctuates with network demand, using EIP-1559 base fee mechanics.`}
        </p>
      </div>

      <AdReserve
        context="gas"
        placement="gas_top"
        className="mb-8"
      />

      <dl className="ledger [--cols:3] mb-8">
        <Fact label="Slow"     gwei={formatGwei(slow)}     basis="base fee" />
        <Fact label="Standard" gwei={formatGwei(standard)} basis="base fee + 10%" />
        <Fact label="Fast"     gwei={formatGwei(fast)}     basis="base fee + 30%" />
      </dl>

      <div className="mb-8 rounded-xl border border-hair bg-card p-6">
        <h2 className="mb-3 text-lg font-semibold tracking-[-0.02em] text-ink">Current Base Fee</h2>
        <p className="font-mono text-4xl font-semibold text-ink">
          {formatGwei(baseFee)}
          <span className="ml-2 font-sans text-xl font-normal text-mut">Gwei</span>
        </p>
        {hasGasFloor && baseFee < MIN_GAS_PRICE && baseFee > 0n && (
          <p className="mt-1 text-xs text-mut">
            Base fee is below the {floorGwei} Gwei minimum. Effective gas price = max(base fee, {floorGwei} Gwei).
          </p>
        )}
      </div>

      <div className="rounded-xl border border-hair bg-card p-4">
        <p className="text-sm text-ink2">
          Gas prices fetched live from {chainConfig.name} RPC.
          {hasGasFloor
            ? ` ${chainConfig.name} has a low network minimum gas price of ${floorGwei} Gwei — validators will not include transactions below this threshold even if the base fee is lower. Transactions are typically confirmed within 1-3 blocks (${confirmationWindow(chainConfig.blockTime)}).`
            : ` Transactions are typically confirmed within 1-3 blocks (${confirmationWindow(chainConfig.blockTime)}).`
          }
        </p>
      </div>
    </div>
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
