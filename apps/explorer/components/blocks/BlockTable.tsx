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
    <div className="bg-card rounded-xl border border-hair overflow-hidden">
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Recent blocks on {chainConfig.name}</caption>
        <thead className="bg-canvas border-b border-hair">
          <tr>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Block</th>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Age</th>
            <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut">Txns</th>
            {!compact && <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut hidden sm:table-cell">Miner</th>}
            {!compact && <th scope="col" className="text-left px-3 sm:px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mut hidden sm:table-cell">Gas Used</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-hair">
          {blocks.map(b => (
            <tr key={b.number} className="hover:bg-canvas transition-colors">
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">
                <Link href={`/blocks/${b.number}`} className="text-acc-ink font-medium hover:underline">
                  {formatNumber(b.number)}
                </Link>
              </td>
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px] text-mut">{timeAgo(new Date(b.timestamp))}</td>
              <td className="px-3 sm:px-4 py-2 font-mono text-[13px]">{b.txCount}</td>
              {!compact && (
                <td className="px-4 py-2 text-mut font-mono text-[13px] hidden sm:table-cell">
                  {b.miner.slice(0, 10)}...
                </td>
              )}
              {!compact && (
                <td className="px-4 py-2 font-mono text-[13px] text-mut hidden sm:table-cell">
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
