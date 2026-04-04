import { getProvider } from '@/lib/rpc'
import { formatGwei } from '@/lib/format'
import { chainConfig } from '@/lib/chain'
import type { Metadata } from 'next'

export const revalidate = 30

export const metadata: Metadata = {
  title: `Gas Tracker`,
  description: `Live ${chainConfig.name} gas price tracker. Check current slow, standard, and fast gas fees in Gwei on ${chainConfig.brandDomain}.`,
  alternates: { canonical: '/gas' },
}

export default async function GasPage() {
  const provider = getProvider()
  let baseFee = 0n
  try {
    const feeData = await provider.getFeeData()
    baseFee = feeData.gasPrice ?? 0n
  } catch {
    // RPC down — show zeros, page still renders
  }
  // BNB Chain has a consensus minimum gas price of 3 Gwei.
  // Ethereum typically has much higher gas prices, so the minimum is effectively 0.
  const MIN_GAS_PRICE = chainConfig.key === 'bnb' ? 3_000_000_000n : 0n
  const effectiveGasPrice = baseFee > MIN_GAS_PRICE ? baseFee : (MIN_GAS_PRICE > 0n ? MIN_GAS_PRICE : baseFee)

  const slow     = effectiveGasPrice
  const standard = (effectiveGasPrice * 110n) / 100n
  const fast     = (effectiveGasPrice * 130n) / 100n

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-8">Gas Tracker</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <GasCard label="Slow"     gwei={formatGwei(slow)}     est="~30s" color="green" />
        <GasCard label="Standard" gwei={formatGwei(standard)} est="~15s" color="yellow" />
        <GasCard label="Fast"     gwei={formatGwei(fast)}     est="~5s"  color="orange" />
      </div>

      <div className="bg-white rounded-xl border shadow-sm p-6 mb-8">
        <h2 className="font-semibold mb-3 text-gray-700">Current Base Fee</h2>
        <p className="text-4xl font-bold">
          {formatGwei(baseFee)}
          <span className="text-xl font-normal text-gray-500 ml-2">Gwei</span>
        </p>
        {chainConfig.key === 'bnb' && baseFee < MIN_GAS_PRICE && baseFee > 0n && (
          <p className="text-xs text-gray-400 mt-1">
            Base fee is below the 3 Gwei minimum. Effective gas price = max(base fee, 3 Gwei).
          </p>
        )}
      </div>

      <div className="bg-white rounded-xl border shadow-sm p-4">
        <p className="text-sm text-gray-500">
          Gas prices fetched live from {chainConfig.name} RPC.
          {chainConfig.key === 'bnb'
            ? ' BNB Chain has a consensus minimum gas price of 3 Gwei — validators will not include transactions below this threshold even if the base fee is lower. Transactions are typically confirmed within 1-3 blocks (~3-9 seconds).'
            : ` Transactions are typically confirmed within 1-3 blocks (~${chainConfig.blockTime}-${chainConfig.blockTime * 3} seconds).`
          }
        </p>
      </div>
    </div>
  )
}

function GasCard({ label, gwei, est, color }: {
  label: string
  gwei: string
  est: string
  color: string
}) {
  const colorMap: Record<string, string> = {
    green:  'border-green-200 bg-green-50',
    yellow: 'border-yellow-200 bg-yellow-50',
    orange: 'border-orange-200 bg-orange-50',
  }
  return (
    <div className={`rounded-xl border p-6 text-center ${colorMap[color] ?? 'border-gray-200 bg-white'}`}>
      <p className="text-lg font-medium mb-2">{label}</p>
      <p className="text-3xl font-bold mb-1">{gwei}</p>
      <p className="text-sm text-gray-500">Gwei · {est}</p>
    </div>
  )
}
