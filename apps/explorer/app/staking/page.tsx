import { getProvider } from '@/lib/rpc'
import { formatNumber } from '@/lib/format'
import { notFound } from 'next/navigation'
import { chainConfig } from '@/lib/chain'

export const revalidate = 30

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
    const provider = getProvider()
    const balance = await provider.getBalance(DEPOSIT_CONTRACT)
    // Each validator stakes 32 ETH
    const totalStakedETH = Number(balance) / 1e18
    const validatorCount = Math.floor(totalStakedETH / 32)

    return {
      validatorCount,
      totalStaked: totalStakedETH,
      apy: null, // Requires external API call
    }
  } catch {
    return null
  }
}

export default async function StakingPage() {
  if (!chainConfig.features.hasStaking) return notFound()

  const stats = await fetchBeaconStats()

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-2">Ethereum Staking</h1>
      <p className="text-gray-500 text-sm mb-8">
        Ethereum uses Proof of Stake consensus since The Merge (September 2022).
        Validators stake 32 ETH to participate in block validation.
      </p>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
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
      </div>

      {/* How staking works */}
      <div className="bg-white rounded-xl border shadow-sm p-6 mb-6">
        <h2 className="font-semibold text-gray-800 mb-4">How Ethereum Staking Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm text-gray-700">
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
      <div className="bg-white rounded-xl border shadow-sm p-4">
        <h2 className="font-semibold mb-3">ETH2 Deposit Contract</h2>
        <div className="flex items-center gap-2 font-mono text-sm text-gray-700">
          <span>0x00000000219ab540356cbb839cbe05303d7705fa</span>
          <a
            href="/address/0x00000000219ab540356cbb839cbe05303d7705fa"
            className={`${chainConfig.theme.linkText} hover:underline text-xs ml-2`}
          >
            View →
          </a>
        </div>
        <p className="text-xs text-gray-500 mt-1">
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
    <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
      <p className="text-sm text-gray-500 mb-2">{label}</p>
      <p className="text-2xl font-bold mb-1">{value}</p>
      <p className="text-xs text-gray-400">{note}</p>
    </div>
  )
}

function Step({ n, title, detail }: { n: number; title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-600 mt-0.5">
        {n}
      </span>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-gray-500">{detail}</p>
      </div>
    </div>
  )
}

function InfoRow({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-gray-300 mt-2" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-gray-500">{detail}</p>
      </div>
    </div>
  )
}
