import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { TxTable } from '@/components/transactions/TxTable'
import { formatGwei, formatNumber, timeAgo } from '@/lib/format'
import { CopyButton } from '@/components/ui/CopyButton'
import Link from 'next/link'
import type { Metadata } from 'next'
import { fetchBlockFromRpc, type RpcBlock } from '@/lib/rpc-fallback'
import { chainConfig } from '@/lib/chain'

export const revalidate = 300

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> {
  const { number } = await params
  const blockNumber = Number(number)
  if (isNaN(blockNumber)) return { title: `Block Not Found — ${chainConfig.brandName}` }
  let block: typeof schema.blocks.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.blocks).where(eq(schema.blocks.number, blockNumber)).limit(1)
    block = row ?? null
  } catch { /* DB error */ }
  if (!block) return { title: `Block #${formatNumber(blockNumber)} — ${chainConfig.brandName}` }
  return {
    title: `Block #${formatNumber(blockNumber)} — ${chainConfig.brandName}`,
    description: `${chainConfig.name} block #${formatNumber(blockNumber)} validated by ${block.miner.slice(0, 14)}…. Contains ${block.txCount} transactions.`,
    openGraph: {
      title: `Block #${formatNumber(blockNumber)}`,
      description: `${block.txCount} transactions · Validator: ${block.miner.slice(0, 14)}…`,
    },
  }
}

export default async function BlockDetailPage({
  params,
}: {
  params: Promise<{ number: string }>
}) {
  const { number } = await params
  const blockNumber = Number(number)

  if (isNaN(blockNumber) || blockNumber < 0 || !Number.isInteger(blockNumber)) notFound()

  let dbBlock: typeof schema.blocks.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.blocks).where(eq(schema.blocks.number, blockNumber))
    dbBlock = row ?? null
  } catch { /* DB error — fall through to RPC */ }

  const rpcBlock: RpcBlock | null = !dbBlock ? await fetchBlockFromRpc(blockNumber) : null
  const block = dbBlock ?? rpcBlock
  if (!block) notFound()

  const fromRpc = !dbBlock && !!rpcBlock

  const txs = fromRpc
    ? []
    : await db.select().from(schema.transactions)
        .where(eq(schema.transactions.blockNumber, blockNumber))
        .limit(50)

  const gasUsedPct = block.gasUsed && block.gasLimit
    ? ((Number(block.gasUsed) / Number(block.gasLimit)) * 100).toFixed(2)
    : '0'

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">Block #{formatNumber(block.number)}</h1>
        <a
          href={`${chainConfig.externalExplorerUrl}/block/${block.number}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`ml-auto text-xs text-gray-400 hover:${chainConfig.theme.linkText} border border-gray-200 hover:${chainConfig.theme.border} rounded px-2 py-1 transition-colors`}
        >
          View on {chainConfig.externalExplorer} ↗
        </a>
      </div>

      <div className="bg-white rounded-xl border shadow-sm mb-8 overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y">
            <DetailRow label="Block Height" value={formatNumber(block.number)} />
            <DetailRow
              label="Timestamp"
              value={`${timeAgo(new Date(block.timestamp))} (${new Date(block.timestamp).toUTCString()})`}
            />
            <DetailRow label="Transactions" value={`${block.txCount} transactions in this block`} />
            <DetailRow label="Validator" value={block.miner} mono copy />
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

      {fromRpc && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-6 flex items-center gap-2 text-sm text-amber-800">
          <span>⚡</span>
          <span>Block fetched live from {chainConfig.name} — predates our index. Click any transaction hash below to view details.</span>
        </div>
      )}

      <h2 className="text-lg font-semibold mb-4">
        Transactions ({fromRpc ? (rpcBlock?.txHashes.length ?? 0) : txs.length}{!fromRpc && txs.length === 50 ? '+' : ''})
      </h2>
      {fromRpc && rpcBlock && rpcBlock.txHashes.length > 0 ? (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-gray-500">Transaction Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rpcBlock.txHashes.slice(0, 50).map(h => (
                <tr key={h} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/tx/${h}`} className={`${chainConfig.theme.linkText} hover:underline`}>{h}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : txs.length > 0 ? (
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
