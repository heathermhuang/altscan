// apps/explorer/verify-holders-lazy.mjs
// Static wiring check for the lazy-loaded token holders (off-SSR Moralis).
// Local tsc/vitest are broken (esbuild/drizzle skew, see CLAUDE.md), so this asserts the
// source wiring invariants instead. Run: node apps/explorer/verify-holders-lazy.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('FAIL:', msg) } }

const route = read('app/api/internal/token/[address]/holders/route.ts')
const lazy = read('app/token/[address]/HoldersLazy.tsx')
const page = read('app/token/[address]/page.tsx')

// --- internal route: Moralis-enabled, off-SSR endpoint ---
ok(/export const dynamic = 'force-dynamic'/.test(route), '1. route is force-dynamic')
ok(/getTokenHolders\(address\.toLowerCase\(\)\)/.test(route), '2. route calls getTokenHolders (Moralis enabled, lowercased)')
ok(!/skipMoralis/.test(route), '3. route does NOT skip Moralis (real-browser XHR gets accurate holders)')
ok(/cache-control.*private, no-store/.test(route), '4. route is no-store (per-user, never CDN-cached)')

// --- HoldersLazy client component ---
ok(/^'use client'/.test(lazy), '5. HoldersLazy is a client component')
ok(/from '@\/lib\/chain-client'/.test(lazy), "6. imports chainConfig from @/lib/chain-client (NOT @/lib/chain — the label-bug guard)")
ok(!/from '@\/lib\/chain'/.test(lazy), '7. does NOT import the server @/lib/chain into a client component')
ok(/import type \{ HoldersResult \}/.test(lazy), '8. imports HoldersResult as a TYPE (no server runtime pulled into client)')
ok(/fetch\(`\/api\/internal\/token\/\$\{address\}\/holders`\)/.test(lazy), '9. fetches the internal holders route')
ok(/export function HoldersLazy/.test(lazy) && /export function HoldersCountLazy/.test(lazy), '10. exports both HoldersLazy and HoldersCountLazy')
ok(/const inflight = new Map/.test(lazy), '11. shares ONE in-flight fetch per address (table + count dedupe)')
ok(/if \(data\.holders\.length === 0\) return null/.test(lazy), '12. renders nothing when there are no holders to show')

// --- token page: SSR no longer calls Moralis for holders ---
ok(/getTokenHolders\(addr, \{ skipMoralis: true \}\)/.test(page), '13. SSR holders call always skips Moralis (0 CU for crawlers AND no-JS scrapers)')
ok(!/from 'next\/headers'/.test(page), '14. page no longer imports next/headers (SSR bot-gate removed)')
ok(!/isBotRequest/.test(page), '15. page no longer references isBotRequest')
ok(/<HoldersLazy\b/.test(page) && /<HoldersCountLazy\b/.test(page), '16. page renders HoldersLazy + HoldersCountLazy')
ok(!/\btopHolders\b/.test(page) && !/\btotalSupplyBig\b/.test(page), '17. page dropped the now-unused topHolders / totalSupplyBig locals')
ok(/\{!isLive && \(\s*<HoldersLazy/.test(page), '18. HoldersLazy gated to indexed (!isLive) tokens, matching prior behavior')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
