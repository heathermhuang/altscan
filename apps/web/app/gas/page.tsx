import { getProvider } from '@/lib/rpc'
import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'
import { formatGwei } from '@/lib/format'

export const revalidate = 15

export default async function GasPage() {
  const provider = getProvider()
  const feeData = await provider.getFeeData()

  const baseFee = feeData.gasPrice ?? 0n
  const slow     = (baseFee * 100n) / 100n
  const standard = (baseFee * 110n) / 100n
  const fast     = (baseFee * 130n) / 100n

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-8">Gas Tracker</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <GasCard label="🐢 Slow"     gwei={formatGwei(slow)}     est="~30s" color="green" />
        <GasCard label="🚗 Standard" gwei={formatGwei(standard)} est="~15s" color="yellow" />
        <GasCard label="🚀 Fast"     gwei={formatGwei(fast)}     est="~5s"  color="orange" />
      </div>

      <div className="bg-white rounded-xl border shadow-sm p-6 mb-8">
        <h2 className="font-semibold mb-3 text-gray-700">Current Base Fee</h2>
        <p className="text-4xl font-bold">
          {formatGwei(baseFee)}
          <span className="text-xl font-normal text-gray-500 ml-2">Gwei</span>
        </p>
      </div>

      <div className="bg-white rounded-xl border shadow-sm p-4">
        <p className="text-sm text-gray-500">
          Gas prices fetched live from BNB Chain RPC. BNB Chain has a fixed minimum gas price of 3 Gwei.
          Transactions are typically confirmed within 1–3 blocks (~3–9 seconds).
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
