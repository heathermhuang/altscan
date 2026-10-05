import type { CSSProperties } from 'react'
import Link from 'next/link'
import { formatNumber, timeAgo } from '@/lib/format'
import { chainConfig } from '@/lib/chain'
import { shortenAddress } from '@/lib/address-display'
import { gasPct } from '@/lib/tape'

interface BlockRow {
  number: number
  timestamp: Date
  miner: string
  txCount: number
  gasUsed: string | bigint | null
  gasLimit: string | bigint | null
}

export function BlockTable({ blocks, compact = false, gasBar = false }: {
  blocks: BlockRow[]
  compact?: boolean
  /** A bar under Gas Used, filled to the block's share of its gas limit. Off by default: it is per-row markup. */
  gasBar?: boolean
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
            {!compact && <th scope="col" className="hidden sm:table-cell">Validator</th>}
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
                <td className="text-mut hidden sm:table-cell font-mono">
                  {shortenAddress(b.miner)}
                </td>
              )}
              {!compact && (
                <td className="text-mut hidden sm:table-cell">
                  <GasUsed block={b} bar={gasBar} />
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

/** Gas Used cell. No gas figure (null, or 0n for an empty block) reads "—", with no bar. */
function GasUsed({ block, bar }: { block: BlockRow; bar: boolean }) {
  if (!block.gasUsed) return <>—</>
  const pct = gasPct(block.gasUsed, block.gasLimit)
  return (
    <>
      {formatNumber(Number(block.gasUsed))}
      {bar && (
        <>
          {' '}({pct}%)
          <span className="gbar" style={{ '--g': `${pct}%` } as CSSProperties} />
        </>
      )}
    </>
  )
}
