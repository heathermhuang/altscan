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

## Task pool

Ordered by value over risk. Pick from the top; move to Done with the commit.

- **`COMPACT_RETENTION_DAYS` into `config.ts`.** The last pending exemption in
  `env-boundary.test.ts`. It is the retention path: run the two hand-run retention PG suites
  (AGENTS.md) before and after. Its parser returns `Infinity` for unset/invalid, which
  `EnvReader.int` cannot express, so it needs a reader method of its own.
- **Explorer env reads.** 25 `process.env` names across ~20 explorer files, no registry.
  Decide whether a typed `lib/env.ts` (the indexer's model) pays off for a Next app whose
  `NEXT_PUBLIC_*` values are inlined at build time. Inventory first.
- **Exported-for-tests internals.** ~350 exports are referenced only by their own file
  and its test. Mostly a deliberate test seam; review the indexer's
  `ensure-schema.ts` (25), `block-processor.ts` (20) and `token-metadata.ts` (16) for
  real dead code.
- **`render.yaml` comment cites the deleted `@altscan/types`** as the reason for not
  using `--filter @altscan/indexer... build`. The reason is now stale. Changing
  `render.yaml` triggers a Blueprint sync, so fold the fix into the next intended
  `render.yaml` change rather than a comment-only merge.
- **`kv-cache` fallback in `explorer-core`** is another bounded TTL map. It cannot use the
  explorer's `ttl-cache.ts` (packages do not import apps). Leave unless a third package
  needs one.

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

- **Check deployed `REORG_DEPTH`** on `bnbscan-indexer` and `eth-indexer` before merging:
  if it is set to anything but a plain whole number, it now falls back to the chain
  default (15 BNB, 3 ETH). The boot log line `ignored` will show it after deploy.
- **Same check for `BODY_CACHE_TTL_MS` / `BODY_CACHE_WINDOW_BYTES`** on both web services:
  a non-integer value now falls back to the default instead of being parsed by
  `parseInt`.
