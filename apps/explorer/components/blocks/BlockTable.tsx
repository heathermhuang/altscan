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
      <table className="dt">
        <caption className="sr-only">Recent blocks on {chainConfig.name}</caption>
        <thead>
          <tr>
            <th scope="col">Block</th>
            <th scope="col">Age</th>
            <th scope="col">Txns</th>
            {!compact && <th scope="col" className="hidden sm:table-cell">Miner</th>}
            {!compact && <th scope="col" className="hidden sm:table-cell">Gas Used</th>}
          </tr>
        </thead>
        <tbody>
          {blocks.map(b => (
            <tr key={b.number}>
              <td>
                <Link href={`/blocks/${b.number}`} className="text-acc-ink font-medium hover:underline">
                  {formatNumber(b.number)}
                </Link>
              </td>
              <td className="text-mut">{timeAgo(new Date(b.timestamp))}</td>
              <td>{b.txCount}</td>
              {!compact && (
                <td className="text-mut hidden sm:table-cell">
                  {b.miner.slice(0, 10)}...
                </td>
              )}
              {!compact && (
                <td className="text-mut hidden sm:table-cell">
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
