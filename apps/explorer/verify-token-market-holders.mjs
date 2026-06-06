/**
 * Standalone logic verification for the token-page market-data + holders feature.
 * Pure JS — no TS/esbuild/DB — runs under the broken local toolchain:
 *   node apps/explorer/verify-token-market-holders.mjs
 * Pure-helper sections REPLICATE the exact bodies from market-data.ts / holders.ts /
 * format.ts and assert their cases (the case table is the contract the .ts must satisfy).
 * Config/wiring sections read source via fs and assert presence (genuine red→green).
 * Render `next build` is the type gate; live curl is behavioral truth.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const readSrc = (rel) => {
  try { return readFileSync(resolve(root, rel), 'utf8') } catch { return '' }
}
let pass = 0, fail = 0
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++ } else { fail++; console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`) }
}
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.error(`  ✗ ${msg}`) } }

// ─────────────────────────────────────────────────────────────────────
// 1. chain-config external-API identifiers
// ─────────────────────────────────────────────────────────────────────
console.log('1. chain-config external-API identifiers')
{
  const src = readSrc('packages/chain-config/src/index.ts')
  for (const field of ['coingeckoPlatform', 'goldrushChain', 'dexscreenerChain']) {
    ok(src.includes(`${field}:`), `1.${field} present on ChainConfig/configs`)
  }
  ok(src.includes("'binance-smart-chain'"), '1.bsc coingeckoPlatform value')
  ok(src.includes("'bsc-mainnet'"), '1.bsc goldrushChain value')
  ok(src.includes("'eth-mainnet'"), '1.eth goldrushChain value')
  ok(src.includes("'ethereum'"), '1.eth coingecko/dexscreener value')
}

// ─────────────────────────────────────────────────────────────────────
// 2. display formatters (keep bodies identical to lib/format.ts)
// ─────────────────────────────────────────────────────────────────────
console.log('2. display formatters')
{
  const formatUsdPrice = (n) => {
    if (!Number.isFinite(n)) return '—'
    const max = n >= 1 ? 2 : n >= 0.01 ? 4 : 8
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })}`
  }
  const formatCompactUsd = (n) => {
    if (!Number.isFinite(n)) return '—'
    return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n)}`
  }
  const formatPercent = (n) => {
    if (!Number.isFinite(n)) return '—'
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
  }
  eq(formatUsdPrice(1234.5), '$1,234.50', '2.price >=1 → 2dp+commas')
  eq(formatUsdPrice(0.1234), '$0.1234', '2.price >=0.01 → 4dp')
  eq(formatUsdPrice(0.00000123), '$0.00000123', '2.price tiny → up to 8dp')
  eq(formatUsdPrice(NaN), '—', '2.price NaN guard')
  eq(formatCompactUsd(1_250_000_000), '$1.25B', '2.compact billions')
  eq(formatCompactUsd(345_600_000), '$345.6M', '2.compact millions')
  eq(formatCompactUsd(12_340), '$12.34K', '2.compact thousands')
  eq(formatPercent(3.2), '+3.20%', '2.percent positive sign')
  eq(formatPercent(-1.5), '-1.50%', '2.percent negative')
}

// ─────────────────────────────────────────────────────────────────────
// 3. market-data pure helpers (keep bodies identical to lib/market-data.ts)
// ─────────────────────────────────────────────────────────────────────
console.log('3. market-data pure helpers')
{
  const pickBestPair = (pairs, tokenAddr, chainId) => {
    const addr = tokenAddr.toLowerCase()
    const eligible = pairs.filter(
      (p) => p.chainId === chainId && p.baseToken?.address?.toLowerCase() === addr,
    )
    if (eligible.length === 0) return null
    return eligible.reduce((best, p) =>
      (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best,
    )
  }
  const num = (v) => {
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
    return Number.isFinite(n) ? n : null
  }
  const buildMarketData = (pair, cg) => ({
    priceUsd: num(pair.priceUsd),
    priceChange24h: num(pair.priceChange?.h24),
    volume24h: num(pair.volume?.h24),
    liquidityUsd: num(pair.liquidity?.usd),
    fdv: num(pair.fdv),
    marketCap: cg?.marketCap ?? num(pair.marketCap),
    circulatingSupply: cg?.circulatingSupply ?? null,
    dexUrl: pair.url ?? null,
    pairLabel: `${pair.baseToken?.symbol}/${pair.quoteToken?.symbol} · ${pair.dexId}`,
    source: cg ? 'dexscreener+coingecko' : 'dexscreener',
  })
  const T = '0xAAA0000000000000000000000000000000000001'
  const pairs = [
    { chainId: 'bsc', dexId: 'pancakeswap', url: 'u1', baseToken: { address: T.toLowerCase(), symbol: 'AAA' }, quoteToken: { symbol: 'WBNB' }, priceUsd: '0.5', liquidity: { usd: 1000 } },
    { chainId: 'bsc', dexId: 'pancakeswap', url: 'u2', baseToken: { address: T.toLowerCase(), symbol: 'AAA' }, quoteToken: { symbol: 'USDT' }, priceUsd: '0.51', priceChange: { h24: -3.2 }, volume: { h24: 4200 }, liquidity: { usd: 9000 }, fdv: 50000 },
    { chainId: 'ethereum', dexId: 'uniswap', url: 'u3', baseToken: { address: T.toLowerCase(), symbol: 'AAA' }, quoteToken: { symbol: 'WETH' }, priceUsd: '0.49', liquidity: { usd: 50000 } },
    { chainId: 'bsc', dexId: 'x', url: 'u4', baseToken: { address: '0xother', symbol: 'OTH' }, quoteToken: { symbol: 'AAA' }, liquidity: { usd: 99999 } },
  ]
  const best = pickBestPair(pairs, T, 'bsc')
  eq(best?.url, 'u2', '3.picks deepest bsc pair where token is base (not eth, not quote-side)')
  eq(pickBestPair(pairs, '0xZZ', 'bsc'), null, '3.no eligible → null')
  const md = buildMarketData(best, { marketCap: 12345, circulatingSupply: 678 })
  eq(md.priceUsd, 0.51, '3.priceUsd parsed')
  eq(md.priceChange24h, -3.2, '3.priceChange parsed')
  eq(md.fdv, 50000, '3.fdv parsed')
  eq(md.marketCap, 12345, '3.coingecko marketCap overrides')
  eq(md.circulatingSupply, 678, '3.coingecko circulating supply')
  eq(md.pairLabel, 'AAA/USDT · pancakeswap', '3.pairLabel composed')
  eq(md.source, 'dexscreener+coingecko', '3.source reflects cg')
  eq(buildMarketData(best, null).source, 'dexscreener', '3.source dex-only when no cg')
  eq(buildMarketData(best, null).marketCap, null, '3.no marketCap when absent both')
}

// ─────────────────────────────────────────────────────────────────────
// 4. holders pure helper (keep body identical to lib/holders.ts)
// ─────────────────────────────────────────────────────────────────────
console.log('4. holders pure helper')
{
  const mapGoldrushHolders = (items) =>
    items
      .filter((it) => it.address && it.balance && it.balance !== '0')
      .map((it) => ({ addr: it.address.toLowerCase(), balance: String(it.balance) }))
  const items = [
    { address: '0xAbC', balance: '100' },
    { address: '0xDdD', balance: '0' },      // dropped: zero
    { address: '0xEeE', balance: null },     // dropped: null
    { address: '', balance: '5' },           // dropped: no address
    { address: '0xFfF', balance: '250' },
  ]
  const mapped = mapGoldrushHolders(items)
  eq(mapped.length, 2, '4.drops zero/null/empty')
  eq(mapped[0], { addr: '0xabc', balance: '100' }, '4.lowercases addr, stringifies balance')
  eq(mapped[1].addr, '0xfff', '4.keeps order')
}

// ─────────────────────────────────────────────────────────────────────
// 5. wiring presence checks (page + clients + env docs)
// ─────────────────────────────────────────────────────────────────────
console.log('5. wiring presence checks')
{
  const page = readSrc('apps/explorer/app/token/[address]/page.tsx')
  ok(page.includes("from '@/lib/market-data'"), '5.page imports market-data')
  ok(page.includes("from '@/lib/holders'"), '5.page imports holders')
  ok(page.includes('getTokenMarketData'), '5.page calls getTokenMarketData')
  ok(page.includes('getTokenHolders'), '5.page calls getTokenHolders')
  ok(!page.includes('fetchTopHolders'), '5.in-page fetchTopHolders removed')
  ok(!/type HolderRow/.test(page), '5.in-page HolderRow type removed')
  ok(page.includes('holdersResult.source'), '5.page is holders-source-aware')
  ok(page.includes('{marketData && ('), '5.page renders market card guarded')
  const env = readSrc('apps/explorer/.env.example')
  ok(env.includes('GOLDRUSH_API_KEY'), '5.env documents GOLDRUSH_API_KEY')
  ok(env.includes('COINGECKO_API_KEY'), '5.env documents COINGECKO_API_KEY')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
