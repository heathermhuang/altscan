import { db, schema } from '@/lib/db'
import { desc, sql } from 'drizzle-orm'
import Link from 'next/link'
import { formatNumber, timeAgo } from '@/lib/format'
import { BlockTable } from '@/components/blocks/BlockTable'
import { TxTable } from '@/components/transactions/TxTable'
import { BlockTape } from '@/components/home/BlockTape'
import { SearchBar } from '@/components/layout/SearchBar'
import { AutoRefresh } from '@/components/ui/AutoRefresh'
import { chainConfig } from '@/lib/chain'
import { AdReserve } from '@/components/ads/AdReserve'
import { swallow, swallowed } from '@/lib/observability'
import { encodeTape, gasPct, latestTapeCount, type TapeTuple } from '@/lib/tape'

// Shared ISR cache: one server render per 30s, served to all users from cache in between.
// This replaces force-dynamic (which rendered fresh for every request) — the primary cause
// Revalidate every 60s. Higher frequency causes concurrent renders that OOM on 2GB.
export const revalidate = 60

// How many blocks the tape draws (lib/tape.ts: ~32s of chain time, BNB 72, ETH 7).
// Kept tight on purpose: the homepage HTML must stay inside one TCP window (Lighthouse mobile LCP).
const TAPE_N = latestTapeCount(chainConfig.blockTime)

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `https://${chainConfig.domain}/#website`,
      url: `https://${chainConfig.domain}`,
      name: `${chainConfig.brandDomain} by MDT`,
      description: `An open, independent ${chainConfig.name} block explorer maintained by Measurable Data Token (MDT).`,
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `https://${chainConfig.domain}/search?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@type': 'Organization',
      '@id': `https://${chainConfig.domain}/#organization`,
      name: 'Measurable Data Token (MDT)',
      url: 'https://mdt.io',
      sameAs: [
        'https://mdt.io',
        'https://github.com/nicemdt',
        'https://twitter.com/nicemdt',
        'https://bnbscan.com',
        'https://ethscan.io',
      ],
    },
  ],
}

async function fetchNativePrice(): Promise<{ usd: number; change24h: number } | null> {
  const binanceSymbol = chainConfig.market.binanceSymbol
  const ccSymbol = chainConfig.market.cryptoCompareSymbol

  // Try multiple Binance endpoints (binance.us for US-based servers like Render)
  for (const host of ['https://api.binance.us', 'https://api.binance.com']) {
    try {
      const res = await fetch(
        `${host}/api/v3/ticker/24hr?symbol=${binanceSymbol}`,
        { next: { revalidate: 60 }, signal: AbortSignal.timeout(3000) }
      )
      if (res.ok) {
        const data = await res.json()
        const price = parseFloat(data.lastPrice)
        const change = parseFloat(data.priceChangePercent)
        if (price > 0) return { usd: price, change24h: change || 0 }
      }
    } catch { /* try next */ }
  }

  // Fallback: CryptoCompare (no API key needed, works from US)
  try {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${ccSymbol}&tsyms=USD`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const raw = data?.RAW?.[ccSymbol]?.USD
      if (raw?.PRICE > 0) return { usd: raw.PRICE, change24h: raw.CHANGEPCT24HOUR ?? 0 }
    }
  } catch { /* try next */ }

  // Fallback: CoinGecko
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const coin = data[chainConfig.coingeckoId]
      if (coin?.usd) {
        return {
          usd: coin.usd,
          change24h: coin.usd_24h_change ?? 0,
        }
      }
    }
  } catch { /* try next */ }

  // Fallback: CoinCap
  const coincapId = chainConfig.market.coincapId
  try {
    const res = await fetch(
      `https://api.coincap.io/v2/assets/${coincapId}`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const price = parseFloat(data?.data?.priceUsd)
      const change = parseFloat(data?.data?.changePercent24Hr)
      if (price > 0) return { usd: price, change24h: change || 0 }
    }
  } catch (e) { swallow('home/price-all-failed', e) }

  return null
}

/** Count transactions indexed in the last 24 hours.
 *
 * Anchors the cutoff to the indexer tip's wall-clock timestamp (not `NOW()`),
 * so the window stays exactly 24h even when the indexer is lagging or when
 * block time varies (ETH missed slots, BSC occasional slow blocks).
 *
 * Sums blocks.tx_count instead of COUNTing the huge transactions table, which
 * keeps the homepage cheap even when crawler pressure ties up DB connections.
 * Returns null on error/timeout so the caller can distinguish "unknown" from
 * a genuine zero.
 */
async function fetchTxCount24h(latestBlock: { timestamp: Date } | undefined): Promise<number | null> {
  if (!latestBlock) return null
  const cutoff = new Date(latestBlock.timestamp.getTime() - 24 * 60 * 60 * 1000)
  try {
    const result = await db.execute(
      sql`SELECT COALESCE(SUM(tx_count), 0)::int AS cnt FROM blocks WHERE timestamp > ${cutoff.toISOString()}`
    )
    return Number(Array.from(result)[0]?.cnt ?? 0)
  } catch {
    return null
  }
}

/** Fetch market cap and 24h change for the native currency from the free price
 * APIs, tried in order. Returns null only if ALL sources fail/rate-limit. */
async function fetchMarketCapFresh(): Promise<{ value: number; change24h: number } | null> {
  const ccSymbol = chainConfig.market.cryptoCompareSymbol

  // Try CryptoCompare (has MKTCAP + CHANGEPCT24HOUR in RAW data)
  try {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${ccSymbol}&tsyms=USD`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const raw = data?.RAW?.[ccSymbol]?.USD
      if (raw?.MKTCAP > 0) return { value: raw.MKTCAP, change24h: raw.CHANGEPCT24HOUR ?? 0 }
    }
  } catch { /* try next */ }

  // Try CoinGecko
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${chainConfig.coingeckoId}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const coin = data[chainConfig.coingeckoId]
      if (coin?.usd_market_cap > 0) return { value: coin.usd_market_cap, change24h: coin.usd_24h_change ?? 0 }
    }
  } catch { /* try next */ }

  // Try CoinCap
  const coincapId = chainConfig.market.coincapId
  try {
    const res = await fetch(
      `https://api.coincap.io/v2/assets/${coincapId}`,
      { next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) }
    )
    if (res.ok) {
      const data = await res.json()
      const mktcap = parseFloat(data?.data?.marketCapUsd)
      const change = parseFloat(data?.data?.changePercent24Hr)
      if (mktcap > 0) return { value: mktcap, change24h: change || 0 }
    }
  } catch (e) { swallow('home/supply-all-failed', e) }

  return null
}

// Circulating supply for the native coin, refined in-process from any successful
// market-cap API response (impliedSupply = reportedCap / price) so it auto-tracks BNB's
// quarterly burns, and seeded from the chain-config constant until/if one succeeds. The
// three free cap APIs above fail persistently from Render's datacenter IPs, but the
// Binance PRICE (fetchNativePrice) is reliable — so deriving cap = price × supply makes
// the homepage's flagship stat as dependable as the price (it only blanks if Binance
// itself is down, vs. the old "—" whenever the cap APIs hiccuped). Only a FRESH cap value
// refines supply: a stale cap ÷ the current price would distort it. In-memory + per
// process; a restart reseeds from the constant, then re-refines on the next good fetch.
let refinedSupply: number | null = null

/** Market cap = reliable native price × circulating supply. `capRaw` is a best-effort
 *  fresh market-cap fetch, used ONLY to refine the supply estimate — never for the value. */
function deriveMarketCap(
  price: { usd: number; change24h: number } | null,
  capRaw: { value: number; change24h: number } | null,
): { value: number; change24h: number } | null {
  if (!price || price.usd <= 0) return null
  if (capRaw && capRaw.value > 0) {
    // Refine supply from a fresh cap, but reject outliers so one bad/stale/wrong-unit
    // provider response can't poison the process-wide estimate (a stale Next Data Cache
    // replay or a value off by orders of magnitude). A real circulating supply sits near
    // the seed — it only drifts with slow burns — so accept only within [0.5×, 2×].
    const implied = capRaw.value / price.usd
    const seed = chainConfig.nativeCirculatingSupply
    if (Number.isFinite(implied) && implied >= seed * 0.5 && implied <= seed * 2) {
      refinedSupply = implied
    }
  }
  const supply = refinedSupply ?? chainConfig.nativeCirculatingSupply
  if (!(supply > 0)) return null
  // Supply is ~constant over 24h, so the cap's 24h change tracks the price's.
  return { value: price.usd * supply, change24h: price.change24h }
}

function formatMarketCap(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  return `$${formatNumber(Math.round(value))}`
}

export default async function HomePage() {
  let latestBlocks: typeof schema.blocks.$inferSelect[] = []
  let latestTxs: typeof schema.transactions.$inferSelect[] = []
  // DB queries get a 15s timeout so build-time SSG doesn't hang when the DB is
  // cold or under heavy indexer load. ISR fills in real data on first visitor.
  function dbTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
    return Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), 15_000))])
  }

  const [blocksResult, txsResult, nativePrice, capRaw] = await Promise.all([
    dbTimeout(db.select().from(schema.blocks).orderBy(desc(schema.blocks.number)).limit(TAPE_N).catch(swallowed('home/blocks', [])), []),
    dbTimeout(db.select().from(schema.transactions).orderBy(desc(schema.transactions.timestamp)).limit(7).catch(swallowed('home/txs', [])), []),
    fetchNativePrice(),
    fetchMarketCapFresh(), // best-effort, only to refine the circulating-supply estimate
  ])

  // Derive cap from the reliable Binance price × supply (the cap APIs fail from Render);
  // capRaw only nudges the supply estimate. Stays populated whenever the price does.
  const marketCap = deriveMarketCap(nativePrice, capRaw)

  latestBlocks = blocksResult
  latestTxs = txsResult

  const latestBlock = latestBlocks[0]
  const tapeTuples: TapeTuple[] = latestBlocks.map(b => [
    b.number,
    Math.floor(new Date(b.timestamp).getTime() / 1000),
    b.txCount,
    gasPct(b.gasUsed, b.gasLimit),
  ])
  const txCount24h = await dbTimeout(fetchTxCount24h(latestBlock), null)

  const priceDisplay = nativePrice
    ? `$${nativePrice.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
  const changeDisplay = nativePrice
    ? `${nativePrice.change24h >= 0 ? '+' : ''}${nativePrice.change24h.toFixed(2)}%`
    : null
  const changePositive = nativePrice ? nativePrice.change24h >= 0 : null

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <AutoRefresh intervalMs={30000} />

      {/* Hero */}
      <div className="hero">
        <p className="k">{'// '}{chainConfig.name} · block explorer</p>
        <h1 className="hero-h">
          {chainConfig.tagline}
        </h1>
        <p className="hero-p">
          Maintained by{' '}
          <a
            href="https://mdt.io"
            target="_blank"
            rel="noopener noreferrer"
            className="lk-u font-medium"
          >
            Measurable Data Token (MDT)
          </a>
          {' '}— open, independent, and community-driven.
        </p>
        <div className="mt-7 max-w-[720px]">
          <SearchBar size="lg" />
        </div>
      </div>

      <BlockTape tape={encodeTape(tapeTuples)} chainName={chainConfig.name} />

      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Stats */}
        <h2 className="sr-only">Network overview</h2>
        <div className="ledger mb-8">
          <StatCard
            label="Latest Block"
            value={latestBlock ? formatNumber(latestBlock.number) : '—'}
            subtext={latestBlock ? timeAgo(new Date(latestBlock.timestamp)) : null}
          />
          <StatCard
            label="24H Transactions"
            value={txCount24h !== null ? formatNumber(txCount24h) : '—'}
            subtext={latestTxs[0] ? `last ${timeAgo(new Date(latestTxs[0].timestamp))}` : null}
          />
          <StatCard
            label={`${chainConfig.currency} Market Cap`}
            value={marketCap ? formatMarketCap(marketCap.value) : '—'}
            subtext={marketCap ? `${marketCap.change24h >= 0 ? '+' : ''}${marketCap.change24h.toFixed(2)}%` : null}
            subtextPositive={marketCap ? marketCap.change24h >= 0 : null}
          />
          <StatCard
            label={`${chainConfig.currency} Price`}
            value={priceDisplay}
            subtext={changeDisplay}
            subtextPositive={changePositive}
          />
        </div>

        <AdReserve
          context="home"
          placement="home_after_stats"
          className="mb-8"
        />

        {/* Two-column layout */}
        <div className="two">
          <section className="min-w-0">
            <SectionHeader title="Latest Blocks" href="/blocks" />
            <BlockTable blocks={latestBlocks.slice(0, 7)} compact />
          </section>
          <section className="min-w-0">
            <SectionHeader title="Latest Transactions" href="/txs" />
            <TxTable txs={latestTxs} compact />
          </section>
        </div>

        {/* Crawlable intro — the only prose on the homepage; stays server-rendered */}
        <section className="mt-10 max-w-3xl">
          <h2 className="h2 mb-2">What is {chainConfig.brandName}?</h2>
          <div className="text-sm text-ink2 space-y-3">
            <p>
              {chainConfig.brandDomain} is an open, independent {chainConfig.name} block
              explorer maintained by Measurable Data Token (MDT). It tracks blocks and
              transactions in real time and offers a{' '}
              <Link href="/token" className="lk-u">token directory</Link>,{' '}
              <Link href="/dex" className="lk-u">DEX trade tracker</Link>,{' '}
              <Link href="/gas" className="lk-u">gas tracker</Link>,{' '}
              <Link href="/whales" className="lk-u">whale tracker</Link>, and a free{' '}
              <Link href="/api-docs" className="lk-u">REST API</Link>
              {' '}— no account required.
            </p>
            <p>
              The same open-source engine,{' '}
              <a href="https://altscan.io" className="lk-u">Altscan</a>,
              powers our sister explorer at{' '}
              <a href={chainConfig.peerUrl} className="lk-u">
                {chainConfig.peerUrl.replace('https://', '')}
              </a>
              . Read more <Link href="/about" className="lk-u">about the project</Link>.
            </p>
          </div>
        </section>
      </div>
    </>
  )
}

function StatCard({
  label,
  value,
  subtext,
  subtextPositive,
}: {
  label: string
  value: string
  subtext?: string | null
  subtextPositive?: boolean | null
}) {
  return (
    <div>
      <p className="k">{label}</p>
      <p className="stat-v">{value}</p>
      {subtext && (
        <p
          className={`stat-s ${
            subtextPositive === true
              ? 'text-live'
              : subtextPositive === false
              ? 'text-warn'
              : 'text-mut'
          }`}
        >
          {subtext}
        </p>
      )}
    </div>
  )
}

function SectionHeader({ title, href }: { title: string; href: string }) {
  return (
    <div className="sec">
      <h2 className="h2">{title}</h2>
      <Link href={href} className="text-sm text-acc-ink hover:underline">View all →</Link>
    </div>
  )
}
