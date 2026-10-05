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
  description: `Ethereum staking dashboard — view active validators, total ETH staked, staking APY, and how Proof of Stake works on ${chainConfig.brandDomain}.`,
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
      { '@type': 'Question', name: 'What is Ethereum staking?', acceptedAnswer: { '@type': 'Answer', text: 'Ethereum staking is the process of depositing 32 ETH to activate validator software. Validators are responsible for proposing and attesting to new blocks on the Ethereum beacon chain. In return, validators earn ETH rewards (currently ~3-4% APY). Staking secures the network through Proof of Stake consensus, which replaced Proof of Work after The Merge in September 2022.' } },
      { '@type': 'Question', name: 'How much ETH do I need to stake?', acceptedAnswer: { '@type': 'Answer', text: 'Running your own validator requires exactly 32 ETH. However, liquid staking protocols like Lido (stETH) and Rocket Pool (rETH) allow you to stake any amount of ETH without running your own node. These protocols pool deposits and distribute rewards proportionally.' } },
      { '@type': 'Question', name: 'What is slashing in Ethereum staking?', acceptedAnswer: { '@type': 'Answer', text: 'Slashing is a penalty mechanism that destroys a portion of a validator\'s staked ETH if they act maliciously or fail to perform their duties (e.g., double-signing blocks or extended downtime). Slashing ensures validators have a financial incentive to behave honestly.' } },
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
          Validators stake 32 ETH to participate in block validation and earn rewards (~3-4% APY).
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

      {/* How staking works */}
      <div className="mb-6 rounded-xl border border-hair bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold tracking-[-0.02em] text-ink">How Ethereum Staking Works</h2>
        <div className="grid grid-cols-1 gap-6 text-sm text-ink md:grid-cols-2">
          <div className="space-y-3">
            <Step n={1} title="Deposit 32 ETH" detail="Send 32 ETH to the deposit contract to activate a validator" />
            <Step n={2} title="Run a Validator Node" detail="Run execution + consensus clients (e.g., Geth + Lighthouse)" />
            <Step n={3} title="Propose & Attest Blocks" detail="Earn rewards for correctly proposing and attesting to blocks" />
          </div>
          <div className="space-y-3">
            <InfoRow title="Slashing Risk" detail="Malicious or faulty validators lose part of their stake" />
            <InfoRow title="Liquid Staking" detail="Use Lido (stETH) or Rocket Pool (rETH) to stake without 32 ETH" />
            <InfoRow title="Withdrawals" detail="Available since the Shanghai upgrade (April 2023)" />
          </div>
        </div>
      </div>

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

function Step({ n, title, detail }: { n: number; title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-hair2 font-mono text-xs font-semibold text-ink2">
        {n}
      </span>
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="text-ink2">{detail}</p>
      </div>
    </div>
  )
}

function InfoRow({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-hair3" />
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="text-ink2">{detail}</p>
      </div>
    </div>
  )
}
