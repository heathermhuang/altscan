import Link from 'next/link'
import { formatNumber, timeAgo } from '@/lib/format'

interface BlockRow {
  number: number
  timestamp: Date
  miner: string
  txCount: number
  gasUsed: string | null
  gasLimit: string | null
}

export function BlockTable({ blocks, compact = false }: {
  blocks: BlockRow[]
  compact?: boolean
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Block</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Age</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Txns</th>
            {!compact && <th className="text-left px-4 py-2 font-medium text-gray-500">Miner</th>}
            {!compact && <th className="text-left px-4 py-2 font-medium text-gray-500">Gas Used</th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {blocks.map(b => (
            <tr key={b.number} className="hover:bg-gray-50">
              <td className="px-4 py-2">
                <Link href={`/blocks/${b.number}`} className="text-yellow-600 font-medium hover:underline">
                  {formatNumber(b.number)}
                </Link>
              </td>
              <td className="px-4 py-2 text-gray-500">{timeAgo(new Date(b.timestamp))}</td>
              <td className="px-4 py-2">{b.txCount}</td>
              {!compact && (
                <td className="px-4 py-2 text-gray-500 font-mono text-xs">
                  {b.miner.slice(0, 10)}...
                </td>
              )}
              {!compact && (
                <td className="px-4 py-2 text-gray-500">
                  {b.gasUsed ? formatNumber(Number(b.gasUsed)) : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
