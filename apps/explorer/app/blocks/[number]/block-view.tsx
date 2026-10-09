import { db, schema } from '@/lib/db'
import { asc, between, desc, eq } from 'drizzle-orm'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { TxTable } from '@/components/transactions/TxTable'
import { formatGwei, formatNumber, formatUtc, timeAgo } from '@/lib/format'
import { CopyButton } from '@/components/ui/CopyButton'
import { Icon } from '@/components/ui/Icon'
import { Pagination } from '@/components/ui/Pagination'
import type { Metadata } from 'next'
import { fetchBlockFromRpc, type RpcBlock } from '@/lib/rpc-fallback'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'
import { shortenAddress, toChecksumAddress } from '@/lib/address-display'
import { swallow } from '@/lib/observability'
import { BlockTape } from '@/components/home/BlockTape'
import { BlockStrip } from '@/components/tape/BlockStrip'
import { getBlockStrip } from '@/lib/block-strip'
import { encodeTape, spreadSeconds, tapeWindow, toTapeTuple } from '@/lib/tape'
import { BLOCK_TXS_PER_PAGE, blockTxsHref, pageExists, txsLabel, txsPageCount } from '@/lib/block-txs'

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

// Pages after the first are DB-only: they can never be served from an RPC block, and every (block,
// page) is its own ISR path, so a node call per miss would multiply upstream load for no render.
// Unlike getBlock this does not swallow a DB error: a failed lookup must be an uncached error
// response, not a 404 that ISR caches for a minute.
const getDbBlock = cache(async (blockNumber: number) => {
  const [row] = await db.select().from(schema.blocks).where(eq(schema.blocks.number, blockNumber)).limit(1)
  return row ?? null
})

async function lookupBlock(blockNumber: number, page: number) {
  if (page === 1) return getBlock(blockNumber)
  return { dbBlock: await getDbBlock(blockNumber), rpcBlock: null }
}

// Missing entities return noindex metadata instead of throwing notFound():
// on this Next version, notFound() from metadata/body during an on-demand
// static render still responds 200 with the not-found UI (and skips the ISR
// cache), so status can't be trusted for SEO. noindex in the head is what
// reliably keeps these off Google. The page body's notFound() still renders
// the 404 UI.
const NOT_FOUND_METADATA: Metadata = {
  robots: { index: false, follow: false },
}

// `page` is null when the route's page segment did not parse (see parseTxsPage).
export async function blockMetadata(blockNumber: number, page: number | null): Promise<Metadata> {
  if (isNaN(blockNumber) || blockNumber < 0 || !Number.isInteger(blockNumber) || page === null) {
    return { title: 'Block Not Found', ...NOT_FOUND_METADATA }
  }
  const { dbBlock, rpcBlock } = await lookupBlock(blockNumber, page)
  const block = dbBlock ?? rpcBlock
  if (!block || !pageExists(page, !!dbBlock, block.txCount)) {
    return { title: 'Block Not Found', ...NOT_FOUND_METADATA }
  }
  // No brand suffix: the layout title template (`%s — ${brandDomain}`) appends it
  const title = page === 1
    ? `Block #${formatNumber(blockNumber)}`
    : `Block #${formatNumber(blockNumber)} · Txns page ${page}`
  return {
    title,
    description: `${chainConfig.name} block #${formatNumber(blockNumber)} validated by ${block.miner.slice(0, 14)}…. Contains ${block.txCount} transactions.`,
    // Page 1 is the canonical block URL. The pages after it are reachable but not worth indexing.
    ...(page > 1 && { robots: { index: false, follow: true } }),
    alternates: { canonical: blockTxsHref(blockNumber, page) },
    openGraph: {
      title,
      description: `${block.txCount} transactions · Validator: ${block.miner.slice(0, 14)}…`,
    },
  }
}

export async function BlockView({ blockNumber, page }: { blockNumber: number; page: number | null }) {
  if (isNaN(blockNumber) || blockNumber < 0 || !Number.isInteger(blockNumber) || page === null) notFound()

  const { dbBlock, rpcBlock } = await lookupBlock(blockNumber, page)
  const block = dbBlock ?? rpcBlock
  if (!block || !pageExists(page, !!dbBlock, block.txCount)) notFound()

  const fromRpc = !dbBlock && !!rpcBlock

  // Ordered by position in the block so a page boundary is the same on every render.
  const txs = fromRpc
    ? []
    : await db.select().from(schema.transactions)
        .where(eq(schema.transactions.blockNumber, blockNumber))
        .orderBy(asc(schema.transactions.txIndex))
        .limit(BLOCK_TXS_PER_PAGE)
        .offset((page - 1) * BLOCK_TXS_PER_PAGE)

  // The tape: this block and its neighbours by primary key (newer ones exist because the indexer
  // is ahead). Omitted for an RPC block (outside local retention), a failed query, or too few
  // neighbours to draw a tile.
  let tape: string | null = null
  if (!fromRpc) {
    const { before, after } = tapeWindow(chainConfig.blockTime)
    try {
      const near = await db
        .select({
          number: schema.blocks.number,
          timestamp: schema.blocks.timestamp,
          gasUsed: schema.blocks.gasUsed,
          gasLimit: schema.blocks.gasLimit,
          txCount: schema.blocks.txCount,
        })
        .from(schema.blocks)
        .where(between(schema.blocks.number, blockNumber - before, blockNumber + after))
        .orderBy(desc(schema.blocks.number))
      const tuples = near.map(toTapeTuple)
      if (spreadSeconds(tuples).length > 0) tape = encodeTape(tuples)
    } catch (e) { swallow('block/tape', e) }
  }

  // The zoom: this block's own transactions. Same omission rules as the tape (two indexed reads).
  const strip = fromRpc ? null : await getBlockStrip(blockNumber)

  const gasUsedPct = block.gasUsed && block.gasLimit
    ? ((Number(block.gasUsed) / Number(block.gasLimit)) * 100).toFixed(2)
    : '0'

  const gasBarPct = Math.min(100, Math.max(0, Number(gasUsedPct)))
  const hairChip = 'rounded-[9px] border border-hair px-2.5 py-1 font-mono text-xs text-ink2 transition-colors hover:border-hair3'

  // One page of rows from the query above; the block's own count says how many there really are.
  const txsCount = fromRpc
    ? `${rpcBlock?.txHashes.length ?? 0}`
    : txsLabel(page, txs.length, block.txCount)

  return (
    <>
    <div className="max-w-7xl mx-auto px-4 pt-8">
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
          sub={formatUtc(new Date(block.timestamp))}
        />
        <Fact label="Transactions" value={formatNumber(block.txCount)} />
        <Fact label="Gas used" value={`${gasUsedPct}%`} sub={formatNumber(Number(block.gasUsed ?? 0))}>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-acc-t" aria-hidden="true">
            <div className="h-full bg-acc" style={{ width: `${gasBarPct}%` }} />
          </div>
        </Fact>
        <Fact label="Validator" value={shortenAddress(block.miner)} title={toChecksumAddress(block.miner)} />
      </dl>
    </div>

    {tape !== null && (
      <BlockTape tape={tape} chainName={chainConfig.name} current={block.number} heading={`around #${formatNumber(block.number)}`} />
    )}
    {strip && (
      <BlockStrip
        txs={strip.txs}
        blockNumber={block.number}
        gasLimit={strip.gasLimit}
        chainName={chainConfig.name}
        className={tape !== null ? 'border-t-0' : undefined}
      />
    )}

    <div className={`max-w-7xl mx-auto px-4 pb-8${tape !== null || strip ? ' pt-6' : ''}`}>
      <dl className="mb-8 divide-y divide-hair rounded-xl border border-hair bg-card">
        <DetailRow label="Validator" value={toChecksumAddress(block.miner)} copy />
        <DetailRow label="Block Hash" value={block.hash} copy />
        <DetailRow label="Parent Hash" value={block.parentHash} copy />
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
          <Icon name="bolt" className="h-4 w-4 text-acc-ink" />
          <span>Block fetched live from {chainConfig.name} — it is outside our local retention window.</span>
        </div>
      )}

      <h2 className="mb-4 text-lg font-semibold tracking-[-0.02em] text-ink">
        Transactions ({txsCount})
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
        <p className="text-mut">{page > 1 ? 'No transactions on this page.' : 'No transactions in this block.'}</p>
      )}
      {!fromRpc && txsPageCount(block.txCount) > 1 && (
        <div className="mt-4 flex justify-end">
          <Pagination
            page={page}
            total={block.txCount}
            perPage={BLOCK_TXS_PER_PAGE}
            baseUrl={blockTxsHref(blockNumber, 1)}
            hrefFor={(p) => blockTxsHref(blockNumber, p)}
          />
        </div>
      )}
    </div>
    </>
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
