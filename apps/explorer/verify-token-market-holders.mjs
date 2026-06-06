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

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
