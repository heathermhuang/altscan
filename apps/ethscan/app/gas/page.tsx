import { getProvider } from '@/lib/rpc'
import { formatGwei } from '@/lib/format'

export const revalidate = 15

export default async function GasPage() {
  let baseFee = 0n
  let maxPriorityFee = 0n
  let hasEip1559 = false

  try {
    const provider = getProvider()
    const [block, feeData] = await Promise.all([
      provider.getBlock('latest'),
      provider.getFeeData(),
    ])
    baseFee = block?.baseFeePerGas ?? 0n
    maxPriorityFee = feeData.maxPriorityFeePerGas ?? 0n
    hasEip1559 = baseFee > 0n
  } catch {
    // RPC unavailable
  }

  const slow = hasEip1559
    ? baseFee + (maxPriorityFee * 80n) / 100n
    : (baseFee * 90n) / 100n

  const standard = hasEip1559
    ? baseFee + maxPriorityFee
    : (baseFee * 110n) / 100n

  const fast = hasEip1559
    ? baseFee + (maxPriorityFee * 150n) / 100n
    : (baseFee * 130n) / 100n

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-8">Gas Tracker</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <GasCard label="🐢 Slow"     gwei={baseFee > 0n ? formatGwei(slow) : '—'}     est="~3 min" color="green" />
        <GasCard label="🚗 Standard" gwei={baseFee > 0n ? formatGwei(standard) : '—'} est="~30s"   color="indigo" />
        <GasCard label="🚀 Fast"     gwei={baseFee > 0n ? formatGwei(fast) : '—'}     est="~12s"   color="orange" />
      </div>

      {hasEip1559 && (
        <div className="bg-white rounded-xl border shadow-sm p-6 mb-8">
          <h2 className="font-semibold mb-4 text-gray-700">EIP-1559 Gas Breakdown</h2>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs text-gray-500 mb-1 uppercase tracking-wider">Base Fee</p>
              <p className="text-3xl font-bold">
                {formatGwei(baseFee)}
                <span className="text-xl font-normal text-gray-500 ml-2">Gwei</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Set by the network — burned with each transaction
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1 uppercase tracking-wider">Priority Fee (Tip)</p>
              <p className="text-3xl font-bold">
                {formatGwei(maxPriorityFee)}
                <span className="text-xl font-normal text-gray-500 ml-2">Gwei</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Goes to the validator — incentivizes faster inclusion
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border shadow-sm p-4">
        <p className="text-sm text-gray-500">
          Gas prices fetched live from Ethereum RPC. Since EIP-1559 (London fork), Ethereum uses
          a base fee that is burned and a priority fee (tip) that goes to the validator.
          Max fee = Base Fee + Priority Fee. Blocks target 15M gas; if a block exceeds this,
          the base fee increases up to 12.5% for the next block.
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
    indigo: 'border-indigo-200 bg-indigo-50',
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
