# Altscan — Agent Instructions

Multi-chain EVM explorer platform. One codebase, two products: **BNBScan** (bnbscan.com)
and **EthScan** (ethscan.io). pnpm + Turborepo monorepo, deployed on Render.

Human contributors: start with [CONTRIBUTING.md](CONTRIBUTING.md). Maintainer-only notes
about the hosted deployment live in `AGENTS.local.md` (gitignored) when present.

## Commands

```bash
pnpm install
pnpm dev     # turbo run dev — all apps
pnpm build   # turbo run build — includes the indexer's `tsc`, so it does typecheck it
pnpm lint    # turbo run lint
pnpm test    # vitest run (root config, all workspaces)
```

- Vitest is configured **only at the repo root** (`vitest.config.ts`); packages have no
  test scripts. Run single files with `npx vitest run <path>`.
- `apps/altscan-site` is **excluded from the root vitest run** — it ships a tsx harness. Run it
  with `pnpm --filter @altscan/site test` (CI runs it as a separate step).
- To typecheck the indexer alone the way CI does, **build order is load-bearing** (providers
  value-imports the explorer-core barrel; both need chain-config first):
  `pnpm --filter @altscan/db build && pnpm --filter @altscan/chain-config build && pnpm --filter @altscan/explorer-core build && pnpm --filter @altscan/providers build && pnpm --filter @altscan/indexer exec tsc --noEmit`

## Testing gotchas

- **PG-gated suites are silently SKIPPED by a bare `pnpm test`.** Each is gated on its own
  env var, and CI runs only five of the seven by name:
  | Suite | Gate | In CI? |
  |---|---|---|
  | `apps/indexer/src/backfill-worker.pg.test.ts` | `BACKFILL_TEST_PG_URL` | yes |
  | `apps/indexer/src/retention-sizes.pg.test.ts` | `SIZES_TEST_PG_URL` | yes |
  | `apps/explorer/lib/backfill-serve.pg.test.ts` | `BACKFILL_TEST_PG_URL` | yes (separate DB) |
  | `packages/db/client.pg.test.ts` | `DB_CLIENT_TEST_PG_URL` | yes |
  | `apps/explorer/lib/address-query.pg.test.ts` | `ADDRESS_QUERY_TEST_PG_URL` | yes |
  | `apps/indexer/src/retention-partition-drop.pg.test.ts` | `BACKFILL_TEST_PG_URL` | **no** |
  | `apps/indexer/src/retention-boundary-partition.pg.test.ts` | `BOUNDARY_TEST_PG_URL` | **no** |
  The last two run nowhere unless you run them by hand — do that before touching retention.
- Each PG suite refuses to run unless the database name looks disposable (contains `test`) —
  keep that guard when adding new ones. They CREATE and DROP production-named tables.
- Local Postgres for those suites: `initdb` + `pg_ctl -o "-p 55432 -c unix_socket_directories="`
  with **`LC_ALL=C`** (otherwise "postmaster became multithreaded"). Long temp-directory
  paths blow the 103-byte socket limit, so connect over TCP, not a unix socket.
- **Some indexer "unit" tests reach a real database** via `getDb()` + a local dotenv file
  (`block-processor.test.ts`, `poison-block-queue.test.ts`, `block-processor-rollback.test.ts`,
  `tt-writer-profile.test.ts`) and write/delete for real. Check what a suite touches first.
- Vitest aliases workspace packages to their **TS source** because `dist/` is gitignored and
  CI never builds before testing. **Alias order is load-bearing**: Vite matches string
  aliases by prefix, so `@altscan/explorer-core/format` must precede `@altscan/explorer-core`.

## Architecture invariants (not evident from the file tree)

- `CHAIN` env var (`bnb` | `eth`) selects everything. `getChainConfig()` in
  `packages/chain-config` defaults to `bnb` when `CHAIN` is unset.
- **Each chain reads a DIFFERENT database env var** — `config.dbEnvVar` is `DATABASE_URL`
  for BNB and `ETH_DATABASE_URL` for ETH. A bare `getDb()` defaults to `DATABASE_URL`,
  which is unset on ETH services, and swallowed catches have made whole features silently
  inert on ETH while BNB worked by luck. Always pass the chain through.
- The indexer is a **direct polling loop with no job queue**.
- One Render service per chain per app, all built from the same source. The Render service
  named `eth-indexer` has `rootDir: apps/indexer`, **not** `apps/eth-indexer`.
- Import `@altscan/explorer-core/format`, **not** the barrel, in code that must stay light.
- New provider cache keys use the `moralis:v2:<chain>:<currency>` prefix.

### processBlock is NOT idempotent
Never replay a block that already exists. `dex_trades` has a serial PK so replays
duplicate rows, webhooks re-fire, and transfers are DELETE+INSERT — so an RPC endpoint
that returns an **empty** receipt array (rather than an error) silently WIPES transfers.

### Probe RPC endpoints at depth, not at `latest`
An endpoint that answers `eth_getBlockByNumber` at the tip may lack `eth_getBlockReceipts`
or return `[]` for it. Known bad: `rpc.flashbots.net` (returns `[]`, worse than erroring),
`1rpc.io` and `cloudflare-eth.com` (no `eth_getBlockReceipts`), `eth.merkle.io`
(Cloudflare 1015 after ~1 call), `publicnode.com` on BNB (403s).

## Config vs runtime state

**Never infer runtime behaviour from a config literal.** `chain-config` hardcodes
`backfill.enabled = false` on both chains, but env vars override config and are set
per-Render-service. A feature ran live and metered for 9 days while both the code and the
docs said "dark". Read the deployed env var or grep the boot log.

Corollary: this file deliberately records **no env var values**. They drift during incident
response and every dated snapshot of them here has gone stale. Fetch them from Render.

## The indexer build gate is real — keep it

`apps/indexer`'s build was once `tsc || true`, making the deploy gate a no-op for weeks. Both
indexer `buildCommand`s in `render.yaml` now end in explicit assertions (`test -s
dist/index.js`, `node --check`, and a `require.resolve` check that `@altscan/chain-config`
resolves to compiled `.js`, since a TS-source entry would only load via Node type-stripping).
**Verify a guardrail can FAIL before trusting it.**

## Retention / disk subsystem (`apps/indexer/src/retention-cleanup.ts`)

This is the most dangerous code in the repo — it deletes data on a threshold.

- `diskPctNow()` is `pg_database_size() / DB_DISK_GB` (a static env var). The numerator excludes
  WAL and other overhead, so the figure runs **~2.5 points optimistic** — the trigger fires late.
- **Do not "fix" that by shrinking the denominator.** Overhead is mostly WAL, which spikes
  and collapses at checkpoints; a spike would then fire `runCleanup({compactDays:1})`
  EARLY and permanently destroy compact history. "Fires late" beats "may destroy data early".
- `EMERGENCY_DISK_ALARM_PCT` (default 85) only warns; `EMERGENCY_DISK_ACT_PCT` (default 93,
  floored at the alarm value) is the **destructive** path — an alarm line is not the
  emergency path firing. `parsePercentEnv` rejects values >100 and falls back to the
  default, so the trigger cannot be disarmed by env alone.
- The disk-% check runs **after** the partition drop, so it samples the sawtooth trough and
  cannot see the mid-prune peak. Never deploy mid-prune at high disk.
- `.github/workflows/sync-db-disk-size.yml` keeps `DB_DISK_GB` equal to the real provisioned
  disk (Render autoscaling changes it underneath you). **Its trigger is `schedule` ONLY,
  deliberately** — this repo is public and the job holds an unscopable Render API key;
  `push`, `pull_request` and even `workflow_dispatch` would let branch content choose the
  code that runs beside the secret. Re-run failures via "Re-run jobs" on the run itself.
- **`[retention] Done` prints unconditionally** — a phase completing is not the cleanup
  completing.
- A BNB retention run takes ~25–70 min since #143 (compact DELETE 11–53 min + VACUUM 13–19 min;
  ETH ~25–30). The 60–295 min runs, silent during the input prune, were the UPDATE #143 skips.
- Retention changes show up as a **plateau, never a shrink** — the sizes line is measured
  pre-VACUUM.
- With `COMPACT_RETENTION_DAYS == RETENTION_DAYS`, no `body_pruned` rows survive a run. A
  persistent compact population requires COMPACT > RETENTION. #143 skips the in-place input
  body prune whenever compact <= body, since the compact prune deletes those rows anyway. **Never
  set BNB `RETENTION_DAYS` below `COMPACT_RETENTION_DAYS`** — it brings back the ~20h UPDATE.
- During a prune, transfer-writer SQL degrades 200–300x (~295ms → 60–90s), which also
  starves gap healing. Root-cause indexer lag there before blaming RPC.
- `addresses` is **not retention-managed** and grows unbounded. It also never autovacuums
  at default settings (100M rows puts the trigger at ~20M dead tuples) — a per-table
  `autovacuum_vacuum_scale_factor` is set; keep it.
- `VACUUM FULL`: set `VACUUM_FULL=1`, restart, then remove the var. Takes
  AccessExclusiveLock — it stalls everything.
- Manual prune: `POST /api/admin/db-prune` with `Authorization: Bearer <ADMIN_SECRET>`
  (`ADMIN_SECRET` is a Render env var on the web service).

## Do not change

- ⛔ **Do not enable `GAP_HEAL_ENABLED`.** Off by design — reasoning is in the long comment
  at `apps/indexer/src/index.ts:285`. The machinery is complete, but `processBlock` persists
  block+transactions *before* its receipt-derived writes, the work set is absent-only so it
  never retries, and verification checks only presence and transaction count — so a range can
  be **stamped healed with transfers, DEX trades and webhooks missing** and reported as
  `completeness: ok`. In the comment's own words: *"strictly worse than having no healer."*
  It also heals at ~1.7 blocks/min. Fix the completion marker first, then revisit.
- **Do not add `force-dynamic` to an explorer page.** Pages use ISR (`export const
  revalidate`, 45s–3600s per page). Per-request rendering OOMs the 2GB web service; even
  raising the homepage's `revalidate = 60` causes concurrent renders that OOM. API routes
  under `app/api/` legitimately set `force-dynamic` — that is not the same thing.
- Gaps below the compact retention cutoff are **unhealable by design** and age out on their
  own. Never infer the retention floor from `MIN(blocks.number)`; a `blocks` row is not
  proof the block was fully processed.
- Quarantined blocks (`poison_blocks`) are excluded from the healer's work set on purpose.
  `unwindFrom()` must delete `poison_blocks` **first**, before any block-scoped table —
  pinned by `apps/indexer/src/reorg-unwind-order.test.ts`.

## Known issues (accepted)

- `holder_count` is eventually consistent — recomputed by `recomputeHolderCounts()` on an
  interval (default 15 min, `HOLDER_COUNT_INTERVAL_MIN`) rather than per block. Worth ~6x
  ETH throughput.
- DEX "Unique Traders" shows 1 when there are 0 trades — `GREATEST(1, (reltuples / 10))`
  estimate in `apps/explorer/app/dex/page.tsx:49`. Cosmetic.
- `token_balances_token_address_holder_address_key` (~519 MB, 0 scans) is dead weight but
  backs a UNIQUE constraint — removal needs care.

## Conventions

- `packages/db/schema.ts` is the schema source of truth (Drizzle).
- Licensed AGPL-3.0. Blockscout relicensed off GPL in 2026, which makes this a
  differentiator — do not relicense the codebase permissive without a decision.
