import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { TxTable } from '@/components/transactions/TxTable'
import { formatGwei, formatNumber, timeAgo } from '@/lib/format'
import { CopyButton } from '@/components/ui/CopyButton'
import Link from 'next/link'

export default async function BlockDetailPage({
  params,
}: {
  params: Promise<{ number: string }>
}) {
  const { number } = await params
  const blockNumber = Number(number)

  if (isNaN(blockNumber)) notFound()

  const [block] = await db.select().from(schema.blocks)
    .where(eq(schema.blocks.number, blockNumber))

  if (!block) notFound()

  const txs = await db.select().from(schema.transactions)
    .where(eq(schema.transactions.blockNumber, blockNumber))
    .limit(50)

  const gasUsedPct = block.gasUsed && block.gasLimit
    ? ((Number(block.gasUsed) / Number(block.gasLimit)) * 100).toFixed(2)
    : '0'

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Block #{formatNumber(block.number)}</h1>

      <div className="bg-white rounded-xl border shadow-sm mb-8 overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y">
            <DetailRow label="Block Height" value={formatNumber(block.number)} />
            <DetailRow
              label="Timestamp"
              value={`${timeAgo(new Date(block.timestamp))} (${new Date(block.timestamp).toUTCString()})`}
            />
            <DetailRow label="Transactions" value={`${block.txCount} transactions in this block`} />
            <DetailRow label="Miner" value={block.miner} mono copy />
            <DetailRow label="Block Hash" value={block.hash} mono copy />
            <DetailRow label="Parent Hash" value={block.parentHash} mono copy />
            <DetailRow
              label="Gas Used"
              value={`${formatNumber(Number(block.gasUsed ?? 0))} (${gasUsedPct}%)`}
            />
            <DetailRow label="Gas Limit" value={formatNumber(Number(block.gasLimit ?? 0))} />
            {block.baseFeePerGas && (
              <DetailRow
                label="Base Fee Per Gas"
                value={`${formatGwei(BigInt(block.baseFeePerGas))} Gwei`}
              />
            )}
          </tbody>
        </table>
      </div>

      <h2 className="text-lg font-semibold mb-4">
        Transactions ({txs.length}{txs.length === 50 ? '+' : ''})
      </h2>
      {txs.length > 0 ? (
        <TxTable txs={txs} />
      ) : (
        <p className="text-gray-500">No transactions in this block.</p>
      )}
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono = false,
  copy = false,
}: {
  label: string
  value: string
  mono?: boolean
  copy?: boolean
}) {
  return (
    <tr>
      <td className="px-6 py-3 text-gray-500 w-48 font-medium shrink-0">{label}</td>
      <td className={`px-6 py-3 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
        {copy && <CopyButton text={value} />}
      </td>
    </tr>
  )
}
