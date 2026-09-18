# Contributing to Altscan

Thanks for your interest in **Altscan** — the open-source, multi-chain block explorer platform powering [bnbscan.com](https://bnbscan.com) and [ethscan.io](https://ethscan.io).

## Prerequisites

- **Node.js 22** — what CI, the Docker images, and the hosted explorers run.
- **pnpm 10** — the exact version is pinned in `package.json` (`packageManager`);
  `corepack enable` picks it up.
- **PostgreSQL 16**. The quickest way to get it is `docker compose up -d postgres` from
  the repo root: it listens on `localhost:5432`, user, password, and database all `altscan`.
- **Redis 7** is optional. Without `REDIS_URL`, rate limits and caches fall back to
  per-process memory.

## Development setup

```bash
git clone https://github.com/heathermhuang/altscan.git
cd altscan
pnpm install
cp apps/explorer/.env.example apps/explorer/.env.local   # fill in RPC + DB URLs
CHAIN=bnb NEXT_PUBLIC_CHAIN=bnb pnpm --filter @altscan/explorer dev
```

The BNB explorer runs at `http://localhost:3000`. `pnpm dev` starts every app at once
(explorer, indexer, status page, and both Astro sites).

## The `CHAIN` model

One codebase serves every chain. A single `CHAIN` environment variable (`bnb` or `eth`) selects which chain a deployment serves or indexes — same frontend, same indexer, same schema. Chain-specific differences (currency, theme, RPC, feature flags) live in [`packages/chain-config`](packages/chain-config). Client components must read chain config from the client helper (`@/lib/chain-client`), never from server-only config — it reads `NEXT_PUBLIC_CHAIN`, which Next inlines at build time, so set it to the same value as `CHAIN`.

Each chain reads its own database variable: `DATABASE_URL` for BNB and `ETH_DATABASE_URL`
for Ethereum. Pass the chain through to `getDb()` rather than relying on its default.

Run a single chain/app:

```bash
CHAIN=bnb NEXT_PUBLIC_CHAIN=bnb pnpm --filter @altscan/explorer dev         # BNB explorer
CHAIN=eth NEXT_PUBLIC_CHAIN=eth pnpm --filter @altscan/explorer dev -p 3001 # ETH explorer
CHAIN=bnb pnpm --filter @altscan/indexer dev                                # BNB indexer
```

## Before you open a pull request

Run what CI runs:

```bash
pnpm test                               # Vitest, every workspace
pnpm lint
pnpm --filter @altscan/explorer build   # production build of the explorer
pnpm --filter @altscan/site test        # only if you touched apps/altscan-site
```

If you touched the indexer or a package it imports, typecheck it the way CI does. The
build order matters: `providers` imports `explorer-core`, and both need `chain-config`.

```bash
pnpm --filter @altscan/db build && pnpm --filter @altscan/chain-config build && pnpm --filter @altscan/explorer-core build && pnpm --filter @altscan/providers build && pnpm --filter @altscan/indexer exec tsc --noEmit
```

Run a single test file with `npx vitest run <path>`. Vitest is configured only at the repo
root; `apps/altscan-site` has its own harness and is excluded from the root run.

### Tests that need Postgres or Redis

A bare `pnpm test` **skips** these suites. Each runs only when its variable is set. The
Postgres suites refuse to run unless the database name contains `test`, because they
create and drop tables with production names.

| Suite | Variable |
|---|---|
| `apps/indexer/src/backfill-worker.pg.test.ts` | `BACKFILL_TEST_PG_URL` |
| `apps/indexer/src/retention-sizes.pg.test.ts` | `SIZES_TEST_PG_URL` |
| `apps/indexer/src/retention-partition-drop.pg.test.ts` | `BACKFILL_TEST_PG_URL` |
| `apps/indexer/src/retention-boundary-partition.pg.test.ts` | `BOUNDARY_TEST_PG_URL` |
| `apps/explorer/lib/backfill-serve.pg.test.ts` | `BACKFILL_TEST_PG_URL` (use a separate database from the indexer worker suite) |
| `apps/explorer/lib/address-query.pg.test.ts` | `ADDRESS_QUERY_TEST_PG_URL` |
| `packages/db/client.pg.test.ts` | `DB_CLIENT_TEST_PG_URL` |
| `packages/providers/src/moralis-cu-budget.redis.test.ts` | `MORALIS_TEST_REDIS_URL` (changes server config — use a throwaway Redis only) |

The two retention-partition suites are not in CI. Run them by hand before you change
retention code. For example, with Docker:

```bash
docker run --rm -d --name altscan-test-pg -p 55432:5432 -e POSTGRES_PASSWORD=x -e POSTGRES_DB=worker_test postgres:16
DB_CLIENT_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55432/worker_test npx vitest run packages/db/client.pg.test.ts
```

⚠️ A few indexer tests (`block-processor.test.ts`, `poison-block-queue.test.ts`,
`block-processor-rollback.test.ts`, `tt-writer-profile.test.ts`) take `DATABASE_URL` from
`apps/indexer/.env` and write to that database for real. Keep that file pointed at a
disposable database.

## Pull requests

1. Branch from `main`: `git checkout -b feat/my-feature`.
2. Keep changes focused and match the surrounding code style.
3. Run the checks above.
4. Use conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`…). PRs are
   squash-merged, so write the PR title the same way — it becomes the commit.
5. For user-facing changes, add a line under `[Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
6. Open the PR against `main` with a short description of what changed and why.

Every pull request runs CI (tests, lint, builds), CodeQL, and the CLA check below.

## Reporting issues

Open a GitHub issue with steps to reproduce, expected vs. actual behavior, and the chain/page affected. For security-sensitive reports, follow the [Security Policy](SECURITY.md) and disclose privately rather than in a public issue.

## Contributor License Agreement

Altscan is dual licensed: open source under [AGPL-3.0](LICENSE), plus a commercial
licence for organisations that cannot use AGPL code. See [LICENSING.md](LICENSING.md).

To keep that possible, contributions are accepted under our
[Contributor License Agreement](CLA.md). **You keep ownership of your work** — the CLA is
a licence grant, not a copyright assignment, and you remain free to use your
contributions anywhere else.

**To accept:** add your name to [`CONTRIBUTORS.md`](CONTRIBUTORS.md) in your first pull
request. That's the whole process — one line, no forms, no email. It covers every
contribution you make, then and later. The `CLA` check on your pull request fails until
your GitHub username is listed there.

If you're contributing on behalf of an employer, please confirm you're authorised to do
so and note the organisation alongside your name.
