import Link from 'next/link'
import { getWebProvider } from '@/lib/rpc'
import { formatNumber } from '@/lib/format'
import { notFound } from 'next/navigation'
import { chainConfig } from '@/lib/chain'
import { AdReserve } from '@/components/ads/AdReserve'
import type { Metadata } from 'next'
import { swallow } from '@/lib/observability'

export const metadata: Metadata = {
  title: 'Ethereum Staking',
  description: `Ethereum staking dashboard — view active validators, total ETH staked, and staking APY on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/staking' },
}

export const revalidate = 300

if (!chainConfig.features.hasStaking) {
  // Static guard -- will 404 at build time for non-staking chains
}

async function fetchBeaconStats(): Promise<{
  validatorCount: number | null
  totalStaked: number | null
  apy: number | null
} | null> {
  try {
    // Beacon chain deposit contract holds staked ETH
    const DEPOSIT_CONTRACT = '0x00000000219ab540356cbb839cbe05303d7705fa'
    const provider = await getWebProvider()
    const balance = await provider.getBalance(DEPOSIT_CONTRACT)
    // Each validator stakes 32 ETH
    const totalStakedETH = Number(balance) / 1e18
    const validatorCount = Math.floor(totalStakedETH / 32)

    return {
      validatorCount,
      totalStaked: totalStakedETH,
      apy: null, // Requires external API call
    }
  } catch (e) {
    swallow('staking/query', e)
    return null
  }
}

export default async function StakingPage() {
  if (!chainConfig.features.hasStaking) return notFound()

  const stats = await fetchBeaconStats()

  const stakingFaqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'What is Ethereum staking?', acceptedAnswer: { '@type': 'Answer', text: 'Validators stake at least 32 ETH to participate in block validation and earn rewards (~3-4% APY). Ethereum uses Proof of Stake consensus since The Merge (September 2022).' } },
      { '@type': 'Question', name: 'How much ETH do I need to stake?', acceptedAnswer: { '@type': 'Answer', text: 'Running your own validator requires at least 32 ETH.' } },
    ],
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(stakingFaqJsonLd) }}
      />
      <div className="mb-5">
        <p className="k">{'// '}staking</p>
        <h1 className="mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Ethereum Staking</h1>
        <p className="mt-2 max-w-3xl text-sm text-ink2">
          Ethereum uses Proof of Stake consensus since The Merge (September 2022).
          Validators stake at least 32 ETH to participate in block validation and earn rewards (~3-4% APY).
          This page shows live staking statistics derived from the ETH2 deposit contract.
        </p>
      </div>

      {/* Stats */}
      <dl className="ledger [--cols:3] mb-6">
        <StatCard
          label="Active Validators"
          value={stats?.validatorCount ? formatNumber(stats.validatorCount) : '—'}
          note="Approx. based on deposit contract balance"
        />
        <StatCard
          label="Total ETH Staked"
          value={stats?.totalStaked
            ? `${(stats.totalStaked / 1e6).toFixed(2)}M ETH`
            : '—'}
          note="Balance of ETH2 Deposit Contract"
        />
        <StatCard
          label="Current Staking APY"
          value="~3-4%"
          note="Varies with total staked ETH"
        />
      </dl>

      <AdReserve
        context="staking"
        placement="staking_after_stats"
        variant="compact"
        className="mb-6"
      />

      {/* Deposit contract info */}
      <div className="rounded-xl border border-hair bg-card p-4">
        <h2 className="mb-3 text-lg font-semibold tracking-[-0.02em] text-ink">ETH2 Deposit Contract</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm text-ink">
          <span className="break-all">0x00000000219ab540356cbb839cbe05303d7705fa</span>
          <Link
            href="/address/0x00000000219ab540356cbb839cbe05303d7705fa"
            className="text-xs text-acc-ink hover:underline"
          >
            View →
          </Link>
        </div>
        <p className="mt-1 text-xs text-mut">
          The canonical one-way deposit contract deployed on the Ethereum mainnet.
          All validator deposits are made here.
        </p>
      </div>
    </div>
  )
}

function StatCard({ label, value, note }: {
  label: string
  value: string
  note: string
}) {
  return (
    <div>
      <dt className="k">{label}</dt>
      <dd className="mt-1 break-words font-mono text-[15px] text-ink">{value}</dd>
      <dd className="mt-0.5 break-words text-xs text-mut">{note}</dd>
    </div>
  )
}
