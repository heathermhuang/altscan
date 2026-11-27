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
| 13 | `noUnusedLocals` on in every workspace tsconfig except altscan-site (pre-existing errors). Fixed the 7 hits, incl. retention-cleanup's stale `BATCH_SIZE`, a second definition of the delete batch that config already owns | tsc everywhere (lint had missed an orphan from batch 1) |
| 14 | One ad-slot layout (`components/ads/AdFrame.tsx`): the Binance creative (moved verbatim out of the stateful `AdSlot` into `BinanceAd.tsx`) and `HouseAd` each repeated all five variant layouts. Proven with a throwaway harness: all 15 variant/creative renders byte-identical to the pre-change static HTML, and the harness failed on a one-space change | — |
| 15 | One timing helper for duration-bounded tests (`test-support/timing.ts` `bestOfMs`); a second single-sample test flaked at 187 ms | — |
| 16 | One 429 body (`lib/api-rate-limit.ts` `rateLimitResponse`), replacing 14 spelled-out copies. The CSV export (text body) and OAuth (its own Retry-After contract) keep theirs | `lib/rate-limit-response.test.ts` |

## Task pool

Ordered by value over risk. Pick from the top; move to Done with the commit.

- **`COMPACT_RETENTION_DAYS` into `config.ts`.** The last pending exemption in
  `env-boundary.test.ts`. It is the retention path: run the two hand-run retention PG suites
  (AGENTS.md) before and after. Its parser returns `Infinity` for unset/invalid, which
  `EnvReader.int` cannot express, so it needs a reader method of its own.
- **Explorer env reads.** 25 `process.env` names across ~20 explorer files, no registry.
  Decide whether a typed `lib/env.ts` (the indexer's model) pays off for a Next app whose
  `NEXT_PUBLIC_*` values are inlined at build time. Inventory first.
- **altscan-site has no CI typecheck** and `tsc -p apps/altscan-site` reports 10 errors on
  main, all from missing `cloudflare:workers` types. Tried adding `@cloudflare/workers-types`
  as admin does: it then conflicts with the DOM types the browser script
  `src/scripts/tapes.ts` needs (`HTMLElement` not assignable to `ParentNode`), because
  Worker and browser code share one tsconfig. Fix: a separate tsconfig for `src/scripts/`
  (DOM lib) and one for the Worker side (workers-types), then add both to CI.
- **`render.yaml` comment cites the deleted `@altscan/types`** as the reason for not
  using `--filter @altscan/indexer... build`. The reason is now stale. Changing
  `render.yaml` triggers a Blueprint sync, so fold the fix into the next intended
  `render.yaml` change rather than a comment-only merge.
- **`kv-cache` fallback in `explorer-core`** is another bounded TTL map. It cannot use the
  explorer's `ttl-cache.ts` (packages do not import apps). Leave unless a third package
  needs one.

## Considered and declined

Recorded so the next pass does not redo the analysis.

- **Duplicate keccak topic constants** (`Transfer`, `Approval` in `erc20-transfers.ts`,
  `event-decoder.ts`, `tx-decoder.ts`, the indexer). Each is the hash of a fixed
  signature, so the copies cannot drift. No guard needed.
- **Per-file `sleep` one-liners** in the indexer (11). `node:timers/promises` would be the
  canonical form, but `block-processor-integrity.test.ts` uses fake timers, and moving the
  backoff sleeps off the patched global `setTimeout` risks hanging it. The helper cannot
  drift, so the risk buys nothing.
- **Sharing `withTimeout` / address validation across apps**: see ADR 0002.
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

## Pending owner decisions

- **Delete per-block holder tracking?** `holderBalanceTrackingEnabled` is a hardcoded
  `false` (not env-tunable). Behind it sit ~200 lines that cannot run: the holder queue and
  `batchUpdateHolderBalances` in `block-processor.ts`, `recomputeHolderCounts` in
  `retention-cleanup.ts`, and five `HOLDER_*` env vars in `config.ts`. Deleting them is
  behavior-preserving, but it retires a capability AGENTS.md lists as an accepted known
  issue, so it is a product call. Recommendation: delete, and note in AGENTS.md that
  re-enabling means rebuilding it against the partitioned `token_transfers`.
- **Split `block-processor.ts` (2,386 lines)?** It mixes block fetch, receipt-derived
  writes, the async transfer writer, DEX swaps and holder tracking. It is also the
  replay-safety core (AGENTS.md), so a split is a reviewed design change, not a
  clean-up batch. Proposal: extract the transfer writer (queue, coalescing, durable
  watermark) into `transfer-writer.ts` first; it has its own isolation PG suite.

- **Check deployed `REORG_DEPTH`** on `bnbscan-indexer` and `eth-indexer` before merging:
  if it is set to anything but a plain whole number, it now falls back to the chain
  default (15 BNB, 3 ETH). The boot log line `ignored` will show it after deploy.
- **Same check for `BODY_CACHE_TTL_MS` / `BODY_CACHE_WINDOW_BYTES`** on both web services:
  a non-integer value now falls back to the default instead of being parsed by
  `parseInt`.
