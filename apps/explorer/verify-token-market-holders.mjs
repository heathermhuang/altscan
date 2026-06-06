/**
 * Standalone logic verification for the token-page market-data + holders feature.
 * Pure JS — no TS/esbuild/DB — runs under the broken local toolchain:
 *   node apps/explorer/verify-token-market-holders.mjs
 * Pure-helper sections REPLICATE the exact bodies from market-data.ts / moralis.ts /
 * format.ts and assert their cases (the case table is the contract the .ts must satisfy).
 * Config/wiring sections read source via fs and assert presence (genuine red→green).
 * Render `next build` is the type gate; live curl is behavioral truth.
 *
 * Holders source = Moralis (already-wired Pro) /erc20/{addr}/owners + /holders — NOT GoldRush.
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
// 1. chain-config external-API identifiers (market data only; holders reuse moralisChain)
// ─────────────────────────────────────────────────────────────────────
console.log('1. chain-config external-API identifiers')
{
  const src = readSrc('packages/chain-config/src/index.ts')
  for (const field of ['coingeckoPlatform', 'dexscreenerChain']) {
    ok(src.includes(`${field}:`), `1.${field} present on ChainConfig/configs`)
  }
  ok(src.includes("'binance-smart-chain'"), '1.bsc coingeckoPlatform value')
  ok(src.includes("'ethereum'"), '1.eth coingecko/dexscreener value')
  ok(src.includes("dexscreenerChain: 'bsc'"), '1.bsc dexscreenerChain value')
  ok(!src.includes('goldrushChain'), '1.goldrushChain removed (holders use Moralis)')
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
// 4. Moralis owners mapper (keep body identical to lib/moralis.ts mapMoralisOwners)
// ─────────────────────────────────────────────────────────────────────
console.log('4. moralis owners mapper')
{
  const mapMoralisOwners = (items) =>
    items
      .filter((r) => r.owner_address && r.balance && r.balance !== '0')
      .map((r) => ({
        address: r.owner_address.toLowerCase(),
        balance: String(r.balance),
        balanceFormatted: r.balance_formatted ?? null,
        usdValue: r.usd_value ?? null,
        isContract: !!r.is_contract,
        percentage: r.percentage_relative_to_total_supply != null
          ? String(r.percentage_relative_to_total_supply)
          : null,
        label: r.owner_address_label ?? null,
      }))
  const items = [
    { owner_address: '0xAbC', balance: '100', balance_formatted: '1.0', usd_value: '5', is_contract: false, percentage_relative_to_total_supply: 1.5, owner_address_label: 'Binance' },
    { owner_address: '0xDdD', balance: '0' },        // dropped: zero
    { owner_address: '0xEeE', balance: null },       // dropped: null
    { owner_address: '', balance: '5' },             // dropped: no address
    { owner_address: '0xFfF', balance: '250', is_contract: true },
  ]
  const mapped = mapMoralisOwners(items)
  eq(mapped.length, 2, '4.drops zero/null/empty')
  eq(mapped[0], { address: '0xabc', balance: '100', balanceFormatted: '1.0', usdValue: '5', isContract: false, percentage: '1.5', label: 'Binance' }, '4.maps full owner row + lowercases')
  eq(mapped[1], { address: '0xfff', balance: '250', balanceFormatted: null, usdValue: null, isContract: true, percentage: null, label: null }, '4.defaults for sparse row')
}

// ─────────────────────────────────────────────────────────────────────
// 5. wiring presence checks (page + clients + env docs + config)
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
  ok(page.includes("holdersResult.source === 'moralis'"), '5.page holders source = moralis')
  ok(!/goldrush/i.test(page), '5.no goldrush refs left in page')
  ok(page.includes('{marketData && ('), '5.page renders market card guarded')

  const holdersLib = readSrc('apps/explorer/lib/holders.ts')
  ok(holdersLib.includes('getTokenOwners'), '5.holders lib uses Moralis getTokenOwners')
  ok(!/goldrush/i.test(holdersLib), '5.no goldrush refs left in holders lib')

  const moralisLib = readSrc('apps/explorer/lib/moralis.ts')
  ok(moralisLib.includes('export async function getTokenOwners'), '5.moralis exposes getTokenOwners')
  ok(moralisLib.includes('export async function getTokenHolderCount'), '5.moralis exposes getTokenHolderCount')
  ok(moralisLib.includes('MORALIS_DAILY_MAX'), '5.moralis caps env-overridable')

  const env = readSrc('apps/explorer/.env.example')
  ok(!/GOLDRUSH/.test(env), '5.env: GoldRush vars removed')
  ok(env.includes('MORALIS_DAILY_MAX'), '5.env: Moralis Pro cap documented')
  ok(env.includes('COINGECKO_API_KEY'), '5.env documents COINGECKO_API_KEY')

  const config = readSrc('packages/chain-config/src/index.ts')
  ok(!config.includes('goldrushChain'), '5.config: goldrushChain removed')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
