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

## Task pool

Ordered by value over risk. Pick from the top; move to Done with the commit.

Empty. Every remaining item is either declined below (with the reason) or waits on an
owner decision at the end of this file.

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

- `REORG_DEPTH` is now whole-number-or-default (was `parseInt`, so `20.0` read as 20).
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

## Pending owner decisions

- **Fold the stale `render.yaml` comment into the next real `render.yaml` change.** Two
  comments there cite the deleted `@altscan/types` as the reason the indexer build avoids
  `--filter @altscan/indexer... build`. A merge that touches `render.yaml` re-applies the
  Blueprint and can revert dashboard-only changes (AGENTS.local.md), so a comment-only edit
  is not worth a sync. It does not affect any build.
- **Check deployed `REORG_DEPTH`** on `bnbscan-indexer` and `eth-indexer` before merging:
  if it is set to anything but a plain whole number, it now falls back to the chain
  default (15 BNB, 3 ETH). The boot log line `ignored` will show it after deploy.
- **Same check for `BODY_CACHE_TTL_MS` / `BODY_CACHE_WINDOW_BYTES`** on both web services:
  a non-integer value now falls back to the default instead of being parsed by
  `parseInt`.
- **Delete per-block holder tracking?** `holderBalanceTrackingEnabled` is a hardcoded
  `false` (not env-tunable). What it gates is now isolated: `holder-balances.ts` (whole
  module), `recomputeHolderCounts` in `retention-cleanup.ts`, the five `HOLDER_*` vars in
  `config.ts`, and two one-line call sites. Deleting them is behavior-preserving but retires a
  capability AGENTS.md lists as an accepted known issue, so it is a product call.
  Recommendation: delete, and note in AGENTS.md that reviving it means rebuilding it against
  the partitioned `token_transfers`.
