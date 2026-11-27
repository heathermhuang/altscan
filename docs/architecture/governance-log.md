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

## Task pool

Ordered by value over risk. Pick from the top; move to Done with the commit.

- **Indexer env stragglers.** `config.ts` says it is the one place env is read, but
  `provider.ts` and `backfill.ts` each parse the chain RPC list, `provider.ts` reads
  `TRACE_RPC_URL`, `reorg-handler.ts` reads `REORG_DEPTH`, and `retention-policy.ts` reads
  `COMPACT_RETENTION_DAYS`. None of these appear in the boot log's resolved config.
  Move the RPC lists and `REORG_DEPTH` first. `COMPACT_RETENTION_DAYS` is in the retention
  path, so run the two hand-run retention PG suites (AGENTS.md) before touching it.
  Then add a guard: no `process.env` in `apps/indexer/src` outside `config.ts`,
  `config-instance.ts` and the chain DB URL read.
- **Explorer env reads.** 25 `process.env` names across ~20 explorer files, no registry.
  Decide whether a typed `lib/env.ts` (the indexer's model) pays off for a Next app whose
  `NEXT_PUBLIC_*` values are inlined at build time. Inventory first.
- **`packages/providers` typecheck script is broken** (`tsc -p tsconfig.typecheck.json`
  fails on `import.meta` in `guardrail.test.ts`). CI does not run it, so nothing noticed.
  Either fix the tsconfig and run it in CI, or delete the script.
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
- **Flaky wall-clock assertion**: `search-route.test.ts` asserts `< 5 ms` per call and
  failed once at 28 ms under full-suite load. Raise the bound or assert complexity
  (compare a 1k and a 16k input) instead of wall time.

## Pending owner decisions

None yet.
