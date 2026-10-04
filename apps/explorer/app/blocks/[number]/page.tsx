import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { TxTable } from '@/components/transactions/TxTable'
import { formatGwei, formatNumber, timeAgo } from '@/lib/format'
import { CopyButton } from '@/components/ui/CopyButton'
import type { Metadata } from 'next'
import { fetchBlockFromRpc, type RpcBlock } from '@/lib/rpc-fallback'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { shortenAddress, toChecksumAddress } from '@/lib/address-display'
import { swallow } from '@/lib/observability'

// 60s (not 300): with ISR a transient miss — a fresh block during indexer
// lag — caches its 404 for everyone until the next revalidate. Block content
// is immutable, so short revalidation costs one render/min per actively-hit
// path while keeping the fresh-URL 404 window ≤ ~1-2 min.
export const revalidate = 60
// Without generateStaticParams a dynamic-segment route renders per-request
// (verified live: no-store, no full-route ISR — `revalidate` above never
// engaged) and streams a 200 shell before notFound() can throw, so unknown
// block numbers soft-404'd. Empty array = prerender nothing at build; each
// path static-renders on first request, is cached per `revalidate`, and a
// notFound() render returns a real HTTP 404.
export async function generateStaticParams(): Promise<Array<{ number: string }>> {
  return []
}

// One DB→RPC lookup per request, shared by generateMetadata and the page render
// (cache() dedupes).
const getBlock = cache(async (blockNumber: number) => {
  let dbBlock: typeof schema.blocks.$inferSelect | null = null
  try {
    const [row] = await db.select().from(schema.blocks).where(eq(schema.blocks.number, blockNumber)).limit(1)
    dbBlock = row ?? null
  } catch (e) { swallow('block/db-lookup', e) }  // DB error — fall through to RPC
  const rpcBlock: RpcBlock | null = !dbBlock ? await fetchBlockFromRpc(blockNumber) : null
  return { dbBlock, rpcBlock }
})

// Missing entities return noindex metadata instead of throwing notFound():
// on this Next version, notFound() from metadata/body during an on-demand
// static render still responds 200 with the not-found UI (and skips the ISR
// cache), so status can't be trusted for SEO. noindex in the head is what
// reliably keeps these off Google. The page body's notFound() still renders
// the 404 UI.
const NOT_FOUND_METADATA: Metadata = {
  robots: { index: false, follow: false },
}

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> {
  const { number } = await params
  const blockNumber = Number(number)
  if (isNaN(blockNumber) || blockNumber < 0 || !Number.isInteger(blockNumber)) {
    return { title: 'Block Not Found', ...NOT_FOUND_METADATA }
  }
  const { dbBlock, rpcBlock } = await getBlock(blockNumber)
  const block = dbBlock ?? rpcBlock
  if (!block) {
    return { title: 'Block Not Found', ...NOT_FOUND_METADATA }
  }
  return {
    // No brand suffix: the layout title template (`%s — ${brandDomain}`) appends it
    title: `Block #${formatNumber(blockNumber)}`,
    description: `${chainConfig.name} block #${formatNumber(blockNumber)} validated by ${block.miner.slice(0, 14)}…. Contains ${block.txCount} transactions.`,
    alternates: { canonical: `/blocks/${blockNumber}` },
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

  const { dbBlock, rpcBlock } = await getBlock(blockNumber)
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

  const gasBarPct = Math.min(100, Math.max(0, Number(gasUsedPct)))
  const hairChip = 'rounded-[9px] border border-hair px-2.5 py-1 font-mono text-xs text-ink2 transition-colors hover:border-hair3'

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <BreadcrumbJsonLd items={[{ name: 'Blocks', href: '/blocks' }, { name: `Block #${formatNumber(block.number)}` }]} />
      <div className="mb-5">
        <p className="k">{'// '}block</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
            Block <span className="font-mono font-semibold">#{formatNumber(block.number)}</span>
          </h1>
          <nav aria-label="Adjacent blocks" className="flex items-center gap-2">
            {block.number > 0 && (
              <Link href={`/blocks/${block.number - 1}`} className={hairChip}>
                ← #{formatNumber(block.number - 1)}
              </Link>
            )}
            <Link href={`/blocks/${block.number + 1}`} className={hairChip}>
              #{formatNumber(block.number + 1)} →
            </Link>
          </nav>
          <a
            href={`${chainConfig.externalExplorerUrl}/block/${block.number}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`sm:ml-auto ${hairChip}`}
          >
            View on {chainConfig.externalExplorer} ↗
          </a>
        </div>
      </div>

      <dl className="ledger mb-6">
        <Fact
          label="Age"
          value={timeAgo(new Date(block.timestamp))}
          sub={new Date(block.timestamp).toUTCString()}
        />
        <Fact label="Transactions" value={formatNumber(block.txCount)} />
        <Fact label="Gas used" value={`${gasUsedPct}%`} sub={formatNumber(Number(block.gasUsed ?? 0))}>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-acc-t" aria-hidden="true">
            <div className="h-full bg-acc" style={{ width: `${gasBarPct}%` }} />
          </div>
        </Fact>
        <Fact label="Validator" value={shortenAddress(block.miner)} title={toChecksumAddress(block.miner)} />
      </dl>

      <dl className="mb-8 divide-y divide-hair rounded-xl border border-hair bg-card">
        <DetailRow label="Block Height" value={formatNumber(block.number)} />
        <DetailRow
          label="Timestamp"
          value={`${timeAgo(new Date(block.timestamp))} (${new Date(block.timestamp).toUTCString()})`}
        />
        <DetailRow label="Transactions" value={`${block.txCount} transactions in this block`} />
        <DetailRow label="Validator" value={toChecksumAddress(block.miner)} copy />
        <DetailRow label="Block Hash" value={block.hash} copy />
        <DetailRow label="Parent Hash" value={block.parentHash} copy />
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
      </dl>

      {fromRpc && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-hair border-l-[3px] border-l-acc bg-card px-4 py-3 text-sm text-ink2">
          <span>⚡</span>
          <span>Block fetched live from {chainConfig.name} — it is outside our local retention window.</span>
        </div>
      )}

      <h2 className="mb-4 text-lg font-semibold tracking-[-0.02em] text-ink">
        Transactions ({fromRpc ? (rpcBlock?.txHashes.length ?? 0) : txs.length}{!fromRpc && txs.length === 50 ? '+' : ''})
      </h2>
      {fromRpc && rpcBlock && rpcBlock.txs.length > 0 ? (
        // Same table as the indexed path. The bodies arrive with the block, so
        // From / To / Value are all available; only Status is genuinely unknown
        // here (it lives in the receipts), so that column is hidden rather than
        // filled with a guess.
        <TxTable txs={rpcBlock.txs.slice(0, 50)} showStatus={false} />
      ) : txs.length > 0 ? (
        <TxTable txs={txs} />
      ) : (
        <p className="text-mut">No transactions in this block.</p>
      )}
    </div>
  )
}

function Fact({
  label,
  value,
  sub,
  title,
  children,
}: {
  label: string
  value: string
  sub?: string
  title?: string
  children?: React.ReactNode
}) {
  return (
    <div>
      <dt className="k">{label}</dt>
      <dd className="mt-1 break-words font-mono text-[15px] text-ink" title={title}>{value}</dd>
      {sub && <dd className="mt-0.5 break-words text-xs text-mut">{sub}</dd>}
      {children}
    </div>
  )
}

function DetailRow({
  label,
  value,
  copy = false,
}: {
  label: string
  value: string
  copy?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-6 sm:px-6">
      <dt className="text-[13px] text-mut sm:w-44 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-[13px] text-ink">
        {value}
        {copy && <CopyButton text={value} />}
      </dd>
    </div>
  )
}
