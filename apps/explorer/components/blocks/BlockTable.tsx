import Link from 'next/link'
import { formatNumber, timeAgo } from '@/lib/format'
import { chainConfig } from '@/lib/chain'

interface BlockRow {
  number: number
  timestamp: Date
  miner: string
  txCount: number
  gasUsed: string | bigint | null
  gasLimit: string | bigint | null
}

export function BlockTable({ blocks, compact = false }: {
  blocks: BlockRow[]
  compact?: boolean
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Block</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Age</th>
            <th className="text-left px-4 py-2 font-medium text-gray-500">Txns</th>
            {!compact && <th className="text-left px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">Miner</th>}
            {!compact && <th className="text-left px-4 py-2 font-medium text-gray-500 hidden sm:table-cell">Gas Used</th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {blocks.map(b => (
            <tr key={b.number} className="hover:bg-gray-50/80 transition-colors">
              <td className="px-4 py-2">
                <Link href={`/blocks/${b.number}`} className={`${chainConfig.theme.linkText} font-medium hover:underline`}>
                  {formatNumber(b.number)}
                </Link>
              </td>
              <td className="px-4 py-2 text-gray-500">{timeAgo(new Date(b.timestamp))}</td>
              <td className="px-4 py-2">{b.txCount}</td>
              {!compact && (
                <td className="px-4 py-2 text-gray-500 font-mono text-xs hidden sm:table-cell">
                  {b.miner.slice(0, 10)}...
                </td>
              )}
              {!compact && (
                <td className="px-4 py-2 text-gray-500 hidden sm:table-cell">
                  {b.gasUsed ? formatNumber(Number(b.gasUsed)) : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
