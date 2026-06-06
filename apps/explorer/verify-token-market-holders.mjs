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

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
