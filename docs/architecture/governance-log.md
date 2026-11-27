# Governance log

Running record of the architecture clean-up: what is done, what is queued, and what needs
an owner's decision. Each batch is one commit that migrates every caller, deletes what it
replaced, and adds a guard where one makes sense (ADR 0001).

Gate for every batch: the CI typecheck chain (db → chain-config → explorer-core →
providers → indexer `tsc`), explorer/admin/oauth `tsc`, `pnpm lint`, `pnpm test`.

## Done

| # | Batch | Guard |
|---|---|---|
| 1 | Deleted dead code: the unused `@altscan/types` package, six stale formatters in `explorer-core/format` that only `sanitizeSymbol` survived, the indexer's never-imported Sourcify v1 `contract-verifier.ts` and its `SOURCIFY_API` config, and nine unreferenced explorer/indexer exports | workspace graph (#6) catches declared-but-unused packages |
| 2 | One definition of the address/hash shapes (`lib/hex.ts`); 30 inline regexes migrated, each keeping its case rule | `lib/hex.test.ts` |
| 3 | `@altscan/db` getters require the env var: a bare `getDb()` is a type error, not a silent `DATABASE_URL` | `apps/indexer/src/db.test.ts` (`@ts-expect-error`, checked to fail) |
| 4 | One explorer `withTimeout`; the token page's fallback copy leaked its timer | `lib/with-timeout.test.ts` |
| 5 | One in-process cache (`lib/ttl-cache.ts`); six copies migrated, code-cache rebuilt on it, two caches newly visible to `/api/health` | `lib/ttl-cache.test.ts` |
| 6 | The workspace dependency graph is declared and checked; architecture map and ADRs 0001–0002 written | `scripts/workspace-graph.test.ts` (checked to fail) |
| 7 | Indexer env boundary: `REORG_DEPTH` moved into `config.ts` (now in the boot log); `backfill.ts` reuses `provider.ts` instead of re-parsing the RPC list | `apps/indexer/src/env-boundary.test.ts` |
| 8 | Every package `typecheck` script runs in CI (one step replaces the oauth-only one); the providers script, broken unnoticed, fixed | CI `Typecheck packages` |
| 9 | One explorer env-number parser (`lib/env.ts` `positiveIntEnv`); seven hand-rolled parses migrated. `BODY_CACHE_TTL_MS`/`BODY_CACHE_WINDOW_BYTES` used `parseInt`, which read `2h` as 2 ms | `lib/env.test.ts` |
| 10 | De-flaked `search-route.test.ts`: best-of-five timing against 25 ms (the regression it guards cost ~150 ms) instead of one 5 ms sample | — |
| 11 | Narrowed module interfaces: ~100 exports that no file imports (tests included) are now module-private; three fully dead declarations deleted (`format.ts` `formatAddress`, `IndexerConfig`, `CompactTable`). Found with an import-resolving scan; the first name-based scan missed `formatAddress` because a private function elsewhere shared its name | tsc in every workspace |
| 12 | Wallet watch's chain gate is `chainConfig.features.hasWalletWatch` (with the watermark reason next to it) instead of `key === 'bnb'` in five files; removed the `CHAIN_ID` batch 1 orphaned in `goplus.ts` | the flag is the single source; tsc |
| 13 | `noUnusedLocals` on in every workspace tsconfig (altscan-site followed in #17). Fixed the 7 hits, incl. retention-cleanup's stale `BATCH_SIZE`, a second definition of the delete batch that config already owns | tsc everywhere (lint had missed an orphan from batch 1) |
| 14 | One ad-slot layout (`components/ads/AdFrame.tsx`): the Binance creative (moved verbatim out of the stateful `AdSlot` into `BinanceAd.tsx`) and `HouseAd` each repeated all five variant layouts. Proven with a throwaway harness: all 15 variant/creative renders byte-identical to the pre-change static HTML, and the harness failed on a one-space change | — |
| 15 | One timing helper for duration-bounded tests (`test-support/timing.ts` `bestOfMs`); a second single-sample test flaked at 187 ms | — |
| 16 | One 429 body (`lib/api-rate-limit.ts` `rateLimitResponse`), replacing 14 spelled-out copies. The CSV export (text body) and OAuth (its own Retry-After contract) keep theirs | `lib/rate-limit-response.test.ts` |
| 17 | altscan-site typechecks in CI: Worker code (`tsconfig.worker.json`, workers-types) and browser scripts + test harness (`tsconfig.dom.json`) get their own configs, since their lib types conflict. 10 errors on main → 0; `noUnusedLocals` on there too | CI `Typecheck altscan-site` (checked to fail) |
| 18 | `COMPACT_RETENTION_DAYS` read in `config.ts` (`EnvReader.daysOrImmortal`, parseInt semantics kept on purpose: it guards a destructive path) and printed at boot; retention-policy functions take the resolved number. The last `env-boundary` exemption is gone. Both hand-run retention PG suites + `retention-sizes` ran on a local Postgres before (8/8) and after (8/8) | `env-boundary.test.ts`, retention guardrail tests via the real parser |
| 19 | One owning file per explorer env variable, enforced (inventory found no shared reads, so no registry: see declined items) | `lib/env.test.ts` |
| 20 | Split the async transfer writer out of `block-processor.ts` (2,386 → 1,291 lines) into `transfer-writer.ts`, and the disabled holder-balance queue into `holder-balances.ts`. Coupling was measured first: the writer shared only `enqueueTransferWrite` with the rest. Moved verbatim; `SQL_BATCH_CHUNK` and `isDeadlock` (used by all three) moved to the indexer `db.ts`; no re-export layer, all 11 importers repointed. Verified: tsc, 782 indexer unit tests, all 9 indexer PG suites on local Postgres 16.13 (one failure, also on main: a version predicate, fixed in #21), the compiled modules load under Node with no cycle | workspace graph, cycle scan |
| 21 | `tt-whale-index.pg.test.ts`: the "repeated ATTACH re-validates" version predicate excluded only PG 18.0–18.3; 16.13 (measured here) does not re-validate either, so the suite failed on any PG 16 older than 16.14. CI's `postgres:16` is newer, so it never showed there | the test itself |
| 22 | Two more zero-coupling seams out of `block-processor.ts` (1,291 → 1,070): `receipts.ts` (eth_getBlockReceipts and its pre-write field checks; it was filed under the DEX-pair header) and `address-activity.ts` (the addresses coalescer, which used nothing else in the file). Verbatim moves; all 9 indexer PG suites 95/95, compiled modules load | cycle scan, workspace graph |
| 23 | Chain-key audit: every `key === 'bnb'` in apps reviewed. The md route's hardcoded sister-site line now comes from chain-config (`peerUrl` + the peer's name; output identical on both chains). The indexer's `ASYNC_TT_WRITER` default moved from `config.ts` reading `env.CHAIN` itself to `config-instance.ts`, beside the other per-chain indexer defaults, so only chain-config resolves `CHAIN` | — |
| 24 | Audit of page- and component-local helpers against `lib/`: WebMcpProvider had a third address/hash checker built from a template literal (past the batch-2 literal scan) → `lib/hex`, and the hex guard now also rejects any other declaration of those predicate names; three hand-rolled try/await/swallow/fallback blocks → the existing `swallowed()`; `BlockStrip`'s private `fmt` → `formatNumber`. Kept: `BlockTape`'s one-liner (client component; `lib/format` imports ethers) and the search page's try/catch (its callee can throw while building the query, which `.catch` would not see) | `lib/hex.test.ts` (extended) |
| 25 | Published API limits named once (`lib/api-limits.ts`): per-IP, verify, per-key, OAuth token and OAuth mint budgets, list and query page sizes, query max offset. The enforcing code reads them, and api-docs, developer, auth.md, llms.txt and the OpenAPI spec interpolate them (plus `WATCH_MAX_ADDRESSES`) instead of restating 15 literals. The guard caught two copies the first pass missed | `lib/api-limits.test.ts` |
| 26 | One list depth: the token transfer list's own `TOKEN_TRANSFERS_MAX_ROWS` (same 10,000, same OFFSET rationale) and its hand-rolled page clamp → `lib/list-depth.ts` `MAX_LIST_ROWS` / `clampListPage` (identical result: 400 pages of 25). Token-transfers PG suite 24/24 locally | — |
| 27 | One `?page=` rule and page size: the address and token pages had their own `PAGE_SIZE = 25` and `parseInt` parsing → `list-pages.ts` `PER_PAGE` / `parsePageParam`, as `/txs`, `/blocks`, `/dex` use. Valid page numbers serve the same page; junk like `?page=3abc` now serves page 1 there too (was page 3) | `lib/list-depth.test.ts` |
| 28 | The token standards come from the DB enum: `token-type-label.ts` exports `TOKEN_TYPES` (= `schema.tokenTypeEnum.enumValues`) and `parseTokenType`; the tokens API, token list page and both OpenAPI enums stop re-typing `['BEP20','BEP721','BEP1155']` | `lib/token-type-label.test.ts` |
| 29 | `schema.ts` now describes the whole database, enforced. A new PG suite runs the real `ensureSchema()` (twice, for idempotency) on an empty DB and compares tables, columns, nullability and enum values both ways. It found four tables that existed only in raw DDL (`webhook_deliveries`, `indexer_cursor`, `poison_blocks`, `index_gaps` + its three heal columns), now declared; the enum `CREATE TYPE`s are generated from the schema's pgEnums. The reorg guardrail, which scans schema tables, now sees `poison_blocks` and `webhook_deliveries` and excludes each by name with its reason. In CI with its own DB; AGENTS.md table updated | `apps/indexer/src/schema-parity.pg.test.ts` |
| 30 | altscan.io's product cards take brand, domain, URL and chain name from chain-config instead of restating them (new approved edge site → chain-config, consumed from source via a Vite alias + tsconfig path as apps/admin does). Rendered values identical; site typecheck, harness 27/27 and `astro build` pass | `scripts/workspace-graph.test.ts` (edge approved there) |
| 31 | altscan.io's address/hash shapes defined once (`src/lib/hex.ts`): /mcp and the WebMCP tools spelled them six times, one as a template-literal regex. ADR 0001 within the app; the explorers' copy stays separate per ADR 0002 | site harness `test/hex.test.ts` |
| 32 | Third independent review (batches 21–31) found one unnamed change: the canonical `parsePageParam` used `Number()`, so #27 also made `?page=1e2` page 100 and `?page=0x10` page 16 on the address and token pages. The canonical rule is now plain decimal digits (fraction floored), everything else page 1, on every list page. Valid pages unchanged | `lib/page-cache.test.ts` (junk spellings added) |
| 33 | `render.yaml`'s two comments no longer cite the deleted `@altscan/types` as a current fact. Checked with Render's `POST /v1/blueprints/validate` against the live account: valid, `totalActions: 0`, so the merge's Blueprint sync changes no deployed field | `scripts/render-install-frozen.test.ts` still passes |
| 34 | Deleted the hard-disabled per-block holder tracking: `holder-balances.ts`, its two call sites and profile phase, `recomputeHolderCounts` and its schedule, the five `HOLDER_*` config entries and the constant `holderBalanceTrackingEnabled`. The product state is unchanged (counts were already a frozen snapshot); AGENTS.md's known issue now says the code is in history and a revival is a rebuild. All 10 indexer PG suites 98/98; compiled modules load. `HOLDER_*` vars still set on Render are now ignored | config/reorg tests; gate |
| 35 | `REORG_DEPTH` reads exactly as before (parseInt, positive) through `EnvReader.leadingPositiveInt`, the one lenient reader for values moved from parseInt sites where a stricter parse could change a safety setting; `daysOrImmortal` is now that reader with an Infinity fallback. Still printed at boot. This removes the last pre-merge check; the `BODY_CACHE_*` difference is recorded as accepted | `config.test.ts` |
| 36 | Fourth review follow-up: removed `totalInserted` and the inline insert's `RETURNING`, which existed only to gate the holder enqueue #34 deleted (`noUnusedLocals` misses a `+=`-only variable); pinned that a 400-digit `?page=` resolves to the last page, never Infinity | `lib/page-cache.test.ts` |
| 37 | Machine-checked inventory: no two modules in a workspace export the same name. The whole repo had three repeats, each a different concept (server/client `chainConfig`; two cursor formats with opposite junk handling), allowed by name with the reason; after review the wallet-watch codec was renamed `encodeWatchCursor`/`decodeWatchCursor`, leaving `chainConfig` the only exception | `scripts/unique-exports.test.ts` (checked to fail) |

## Task pool

Ordered by value over risk. Pick from the top; move to Done with the commit.

Empty. Every remaining item is either declined below (with the reason) or waits on an
owner decision at the end of this file.

## Convergence

Every area on the governance checklist was scanned; this is where each one ended.

| Area | Outcome |
|---|---|
| UI components and design system | One ad-slot layout (#14). Tokens respected everywhere except the Binance brand colour, on purpose. Page-local helpers folded into `lib/` (#24) |
| Business logic and domain model | Token standards from the DB enum (#28); one list depth (#26) and page rule (#27); chain facts in chain-config (#12, #23, #30) |
| API and data contracts | One 429 body (#16); published limits named once and quoted by every docs surface (#25); error shape already uniform |
| State and data flow | Indexer module state audited: no duplicate state. The transfer writer, receipts and addresses coalescer are their own modules (#20, #22) |
| Data access and caching | DB env var required (#3); `schema.ts` declares every table, enforced against the built DB (#29); one in-process cache (#5) |
| Configuration and env | Indexer env read only in `config.ts` (#7, #18, #23); explorer numbers through one parser and one owner per variable (#9, #19) |
| Error handling and retries | One wait bound (#4); swallow-and-fallback through `swallowed()` (#24); retry backoff sleeps declined (no drift risk) |
| Logging and observability | Two caches made visible to `/api/health` (#5); `REORG_DEPTH` and `COMPACT_RETENTION_DAYS` now in the boot log (#7, #18) |
| Auth and permissions | Rate-limit and OAuth budgets named once (#16, #25); the CORS peer opt-in kept separate on purpose (fork safety) |
| Naming, layout, boundaries | Workspace graph declared and enforced (#6); dead code and ~100 needless exports removed (#1, #11) |
| Utilities and shared infra | Hex shapes once per app (#2, #31); ADR 0002 on what is shared across apps |
| Tests, build, toolchain | Every package typechecks in CI (#8), the site too (#17); `noUnusedLocals` everywhere (#13); three flaky or version-bound tests fixed (#10, #15, #21) |

No safe improvement remains that this pass could find: the task pool is empty, each declined
item has its reason above, and the remaining items need an owner (below).

## Considered and declined

Recorded so the next pass does not redo the analysis.

- **The `kv-cache` fallback in `explorer-core`** is a second bounded TTL map. It cannot use
  the explorer's `ttl-cache.ts` (packages do not import apps), and moving the TTL cache into
  a package for one more caller would add an edge for 20 lines. Revisit only if a third
  package needs one.
- **Splitting `block-processor.ts` past #22** (now 1,070 lines). Every seam was measured.
  The transfer writer, receipts and the addresses coalescer had zero shared state and are
  out. What remains is processBlock with the code it shares module-level mutable state
  with: the token/pair enrichment reads and writes `tokenCache` and `pairCache`, which
  processBlock also reads directly. Moving it means exporting shared mutable state or
  changing processBlock's logic, which is neither verbatim nor behavior-neutral in the
  replay-safety core. Stop here unless processBlock itself is redesigned.

- **Duplicate keccak topic constants** (`Transfer`, `Approval` in `erc20-transfers.ts`,
  `event-decoder.ts`, `tx-decoder.ts`, the indexer). Each is the hash of a fixed
  signature, so the copies cannot drift. No guard needed.
- **Per-file `sleep` one-liners** in the indexer (11). `node:timers/promises` would be the
  canonical form, but `block-processor-integrity.test.ts` uses fake timers, and moving the
  backoff sleeps off the patched global `setTimeout` risks hanging it. The helper cannot
  drift, so the risk buys nothing.
- **Sharing `withTimeout` / address validation across apps**: see ADR 0002.
- **CORS peer from chain-config.** `lib/cors.ts` allows the peer origin only when
  `NEXT_PUBLIC_PEER_URL` is set; chain-config's `peerUrl` holds the same hosted value. Kept
  separate on purpose: a fork must not allowlist the hosted sites' origins by default (same
  rule as `GA_MEASUREMENT_ID` / `BINANCE_REF_CODE` in AGENTS.md).
- **Large but cohesive files** (`ensure-schema.ts` 1,605, `retention-cleanup.ts` 1,295,
  `moralis.ts` 1,217, indexer `index.ts` 999). Each owns one responsibility (boot DDL,
  retention, the Moralis client, the boot loop). The section-coupling scan found no seam
  that is not just a size cut; splitting by size alone is the directory shuffling the goal
  rules out.
- **Indexer module-level state**: every module-level Map/Set was listed; each holds distinct
  state (writer queue, retry bookkeeping, healer strikes, constant allowlists). No two
  duplicate each other.
- **Remaining chain-key lookups** (`LOGOS[chainConfig.key]`, `V2_FACTORIES[key]`, the
  per-chain indexer defaults in `config-instance.ts`) are keyed tables, not scattered
  decisions. Fine as they are.
- **An explorer env registry** (the indexer's `config.ts` model). Inventoried: every
  app-specific variable is read in exactly one file, numeric ones through `positiveIntEnv`.
  A registry would only forward those reads. Enforced instead: `lib/env.test.ts` fails when
  a variable gets a second reader.
- **API error shape**: already uniform (`{ error }` at every `/api/v1` site).
- **Design tokens**: only the ad components use raw colours (Binance brand yellow, on
  purpose).

## Independent review (batches 1–8)

A fresh reviewer read `git diff origin/main..HEAD` against these questions: any deleted
symbol still referenced (including docker/, deploy/, render.yaml), a case rule changed
by the hex migration, a falsy-vs-undefined cache bug, a bare `getDb()` caller, and the
CI step order. It found no breakage. It confirmed these deliberate differences:

- `REORG_DEPTH` was made whole-number-or-default; #35 restored the exact parseInt reading.
- The whales timeout log line lost its `(8000ms)` suffix. Nothing parses it.
- `/api/health` `caches` gains two keys: `tx-lookup-hits`, `code-class`.
- The migrated caches evict LRU instead of FIFO, expire lazily, and no longer run 30s
  sweep timers. Caps and TTLs are unchanged.

## Independent review (batches 9–20)

A second fresh reviewer read `git diff e2a91ea..HEAD`. No production behavior change, nothing
in use removed. It verified by line-multiset diff that `transfer-writer.ts` and
`holder-balances.ts` are verbatim moves with no shared mutable state left behind and a
one-way import chain; that `daysOrImmortal` returns the old parser's result for every
probed input; and that the ad frame, 429 body and wallet-watch flag changes render and
answer identically. Noted, not defects: the wallet-watch 404 text still names BNBScan (it
would need rewording only if ETH enabled the flag), and `COMPACT_RETENTION_DAYS` is now read
once at boot instead of per run (env cannot change without a redeploy).

## Independent review (batches 21–31)

A third fresh reviewer read `git diff 0576a35..HEAD`. It confirmed the receipts and
addresses moves are verbatim with no shared state or cycle, the sister-site line and
`ASYNC_TT_WRITER` default resolve identically, every enforced limit equals the literal it
replaced, `TOKEN_TYPES` keeps its order and never reaches a client bundle, nothing queries
the four newly declared tables through Drizzle, and altscan.io's products and hex checks
are unchanged. One finding, fixed in #32: `parsePageParam` accepted exponent and hex
spellings. Noted: altscan.io's browser WebMCP script now bundles the chain-config literal
(public URLs only, a few KB).

## Independent review (batches 32–35)

A fourth fresh reviewer read `git diff 29a7b49..HEAD`. Valid page numbers parse as before;
`render.yaml` changed comments only; none of the deleted holder code could run, the profile
phase was removed consistently and retention's lag-yield and schedule are intact;
`leadingPositiveInt` returns the old `REORG_DEPTH` result for every probed input and
`daysOrImmortal` is unchanged. Findings: the orphaned `totalInserted`/`RETURNING` and an
untested >308-digit page, both handled in #36; `'+5'`, `'5.'` and similar junk spellings are
now page 1, covered by the accepted `?page=` change.

## Independent review (batches 36–37)

A fifth fresh reviewer read `git diff dd1d1d3..HEAD`: the dropped `RETURNING` had no other
reader and the mocked insert chain still resolves; the 400-digit page test matches the code
and would fail without the clamp; the unique-exports scan sees the repo and its exceptions
are real. Its suggestion, distinct names for the wallet-watch cursor codec, was applied.

## Final verification and stopping condition

On the final commit: the full gate (every workspace typecheck including altscan-site, lint,
3,511 unit tests, the site harness) and all 19 Postgres-gated suites on a local Postgres 16
(indexer 10 files / 98 tests, explorer + db client 9 files / 170 tests). Five independent
reviews cover every commit; the last two found no defects, only a naming suggestion (applied).

Stopped on convergence. The task pool is empty; every checklist area ends in a batch or a
recorded reason; the measured scans that would find more (import-resolving dead-export scan,
cycle scan, workspace graph, section-coupling scan of every file over 800 lines, duplicate
regex/helper/constant greps, schema parity, unique-exports) all come back clean or with
listed exceptions. Further rounds were returning naming-level nits, not entropy.

## Pending owner decisions

None. The two pre-merge checks once listed here were removed by #35 instead of left to the
owner: `REORG_DEPTH` keeps its exact old reading, and the `BODY_CACHE_*` difference is an
accepted, named change (below).

## Accepted behavior changes (named, deliberate)

- **`BODY_CACHE_TTL_MS` / `BODY_CACHE_WINDOW_BYTES`** (#9): a value that is not a positive
  whole number now falls back to the default. Before, `parseInt` read `2h` as a 2 ms TTL and
  garbage or an empty value as NaN. Cache-sizing knobs, not safety bounds; plain integers read
  the same as before.
- **`?page=` junk** (#27, #32): anything but decimal digits is page 1 on every list page.
- **Logs**: the whales timeout line lost its `(8000ms)` suffix (#4); two holder lines left the
  indexer boot log (#34).
