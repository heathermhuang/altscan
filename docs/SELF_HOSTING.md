# Self-hosting Altscan

Run your own block explorer for BNB Chain or Ethereum.

## Quick start

```bash
git clone https://github.com/heathermhuang/altscan.git
cd altscan
cp .env.docker.example .env
docker compose up -d
```

Open <http://localhost:3000>. The stack is Postgres, Redis, the indexer, and the
explorer. First build takes several minutes; after that, startup is seconds.

Every value in `.env` has a working default, so `docker compose up` runs unedited. You
will want to change at least the RPC endpoint and the Postgres password before running
this anywhere other than your laptop. Set the password before the first `up`: Postgres
reads it only when it creates the data volume. The stack also publishes Postgres on
`127.0.0.1:5432` so you can inspect it with `psql` from the same machine; it is not
reachable from other hosts.

Compose passes the containers only the variables listed in
[`docker-compose.yml`](../docker-compose.yml). To set any other variable this guide
mentions, add it to that service's `environment:` block.

```bash
docker compose logs -f indexer     # watch it catch up to the chain head
docker compose down                # stop
docker compose down -v             # stop and delete all indexed data
```

## What you need

| | Minimum | Comfortable |
|---|---|---|
| RAM | 4 GB | 8 GB |
| Disk | 20 GB | 100 GB+ (see [Retention](#retention-and-disk)) |
| RPC | A public endpoint | A dedicated provider endpoint |

Docker Engine 24+ with Compose v2.

## Choosing a chain

```bash
# in .env
CHAIN=eth
```

```bash
docker compose up -d --build
```

**The rebuild is required.** Next.js inlines `NEXT_PUBLIC_CHAIN` into the browser
bundle at build time, so one explorer image serves exactly one chain. Restarting with a
changed `CHAIN` but no rebuild gives you a server reading one chain's data while the
browser renders the other chain's currency symbol and theme.

One compose stack runs one chain. To run both, use two clones with different
`EXPLORER_PORT`, `POSTGRES_PORT` and `COMPOSE_PROJECT_NAME` values (the project name keeps
their containers and data volumes apart), or two Render blueprints.

## Where indexing starts

```bash
START_BLOCK=tip          # default
START_BLOCK_LOOKBACK=1000
```

`tip` is resolved to the live chain head at container start, minus the lookback, by
[`docker/indexer-entrypoint.sh`](../docker/indexer-entrypoint.sh).

This matters more than it looks. The application's built-in defaults are block
**38,000,000** for BNB and block **0** for Ethereum — tens of millions of blocks behind
the head. Starting there means the explorer indexes for days while showing nothing
current, which reads as a broken install. Keep `tip` unless you specifically want
historical backfill.

Altscan does **not** index from genesis. It indexes forward from where you start it, and
serves older address and token history on demand through a provider (below). If you need
a complete archive of all historical state, that is a different architecture — see
[Limitations](#limitations).

## Optional: Moralis for deep history

Without a key, the explorer works, but:

- **Address transaction history** is limited to blocks you have indexed locally.
- **Token holder lists** fall back to a locally computed estimate, shown with a caveat.

With `MORALIS_API_KEY` set ([moralis.io](https://moralis.io), free tier available), both
are served from the provider and cached, giving full history beyond your retention
window. Per-feature rate caps keep one feature from exhausting the quota of another —
see the `MORALIS_*` variables in
[`apps/explorer/.env.example`](../apps/explorer/.env.example). The Docker stack forwards
only `MORALIS_API_KEY`; add the caps to the explorer's `environment:` block to change them.

This is the one place Altscan depends on a third-party commercial service. Everything
else runs from your own node/RPC and your own database.

## Retention and disk

```bash
RETENTION_DAYS=7            # default
COMPACT_RETENTION_DAYS=     # default: unset, keep forever
DB_DISK_GB=                 # default: unset, disk checks off
```

The indexer runs a retention pass 15 minutes after it starts and every 6 hours after that.

- **Past `RETENTION_DAYS`** it deletes logs, DEX trades and gas history, and drops each
  transaction's input data. The transactions stay queryable, and their input is refetched
  from RPC when a page needs it.
- **Past `COMPACT_RETENTION_DAYS`** it deletes the transactions, token transfers, internal
  transactions and blocks themselves. Unset, these are kept forever, so this is the setting
  that bounds block history. Setting it to `RETENTION_DAYS` or lower is the cheap choice:
  old transactions are then deleted outright, without first rewriting each one to drop its
  input, a rewrite that takes hours on a busy chain like BNB.
- **Never pruned:** `addresses`, `tokens`, `token_balances` and `contracts`. `addresses`
  gains a row for every new address the chain touches, so the database keeps growing
  slowly even with both windows set. Leave headroom for it.

As a guide, BNB Chain writes roughly **12–15 GB per month** and Ethereum roughly
**6–8 GB**. Check free disk before you lengthen either window.

The indexer logs table sizes on each pass. With `DB_DISK_GB` set to your disk's size it
also logs disk use, warns at 70%, raises an alarm at `EMERGENCY_DISK_ALARM_PCT` (default
85), and at `EMERGENCY_DISK_ACT_PCT` (default 93) tightens retention and deletes older
data to keep the disk from filling. Without `DB_DISK_GB` none of these checks run. The
figure is the database's own size, so it reads a few points under what `df` reports.

## Deploying on Render

A single-chain template lives at
[`deploy/render/blueprint.yaml`](../deploy/render/blueprint.yaml).

```bash
cp deploy/render/blueprint.yaml render.yaml
```

Commit that to your fork, then in Render: **New → Blueprint → select your fork**. Set
the RPC URL and `START_BLOCK` when prompted. `START_BLOCK` must be a block number here;
`tip` is resolved only by the Docker entrypoint.

For Ethereum, set `CHAIN` and `NEXT_PUBLIC_CHAIN` to `eth`, and on **both** services
rename `DATABASE_URL` to `ETH_DATABASE_URL` and `BNB_RPC_URL` to `ETH_RPC_URL`.

The root [`render.yaml`](../render.yaml) is the production two-chain configuration for
bnbscan.com and ethscan.io — it provisions two databases and paid plans, so don't deploy
it as-is.

> A true one-click **Deploy to Render** button needs a dedicated template repository
> whose root `render.yaml` is the single-chain config. That isn't set up yet; the copy
> step above is the current path.

## Building images directly

```bash
docker build -f docker/Dockerfile.indexer  -t altscan-indexer .
docker build -f docker/Dockerfile.explorer --build-arg CHAIN=bnb -t altscan-explorer:bnb .
```

Note the `--build-arg` on the explorer — see [Choosing a chain](#choosing-a-chain).

## Database

There is no migration step. The indexer creates and updates its own tables and indexes on
boot via [`ensure-schema.ts`](../apps/indexer/src/ensure-schema.ts). Point it at an empty
database and it will do the rest. `token_transfers` starts as a plain table; partitioning
it by block number, which makes retention a cheap partition drop, is an optional one-time
migration (`apps/indexer/src/migrate-partition-tt.ts`, run with the indexer stopped).

```bash
docker compose exec postgres psql -U altscan -d altscan
```

## Troubleshooting

**The homepage looks empty on first load, but `/blocks` has data.**
Expected. The homepage is cached with a 60-second ISR window and ships prerendered
against an empty database. The first request after that window serves the stale copy and
triggers regeneration in the background; the next one shows live data. Reload once.

**`rate limit` / `-32005` errors in the indexer logs.**
The default RPC endpoints are free public nodes and will throttle a catching-up indexer.
Failed blocks are retried, so it self-corrects, but throughput suffers. Lower
`INDEX_CONCURRENCY`, or use a dedicated provider endpoint.

**The indexer says `N blocks behind (>1000) — ABANDONING blocks A..B`.**
It fell more than `MAX_LAG_BLOCKS` (default 1000) behind the head and skipped that range
to stay current. The skipped blocks are recorded as a gap in `/api/health` but are not
filled in later. To avoid it, use a faster RPC endpoint or raise `INDEX_CONCURRENCY`.

**Wrong currency symbol or theme after switching chains.**
You restarted without rebuilding. Run `docker compose up -d --build` — see
[Choosing a chain](#choosing-a-chain).

```bash
docker compose logs -f indexer     # indexing progress and errors
docker compose logs -f explorer    # request-level errors
docker compose ps                  # state of each service; Postgres, Redis and the explorer report health
```

## Limitations

Worth knowing before you commit to this:

- **No genesis archive.** Altscan indexes forward from your start block, with on-demand
  provider backfill for older address/token history. It is not a full archive node
  explorer.
- **One chain per stack**, for the build-time reason above.
- **Contract verification** is via Sourcify only. The explorer shows whether a contract
  is verified there; source is submitted at [sourcify.dev](https://sourcify.dev).
- **Two chains supported** today (BNB, Ethereum). Adding a third currently requires code
  changes, not configuration.

## Before you run a public fork

Analytics and referral ads are off unless you turn them on:

- **`GA_MEASUREMENT_ID`** (e.g. `G-XXXXXXXXXX`) — loads Google Analytics on every page.
  Unset, no analytics script loads.
- **`BINANCE_REF_CODE`** — enables the sponsored Binance placements, linking with your
  referral code. Unset, they never render and no space is reserved for them. House ads
  configured in the admin console (`apps/admin`) are unaffected.

Both are read when pages render, and Next renders the static ones during the build, so
they must reach the build as well as the running server. With Docker, set them in `.env`
and rebuild (`docker compose up -d --build`); the stack passes them to both. On Render,
service environment variables cover both.

Two more things carry the hosted sites' identity and are set per chain in
[`packages/chain-config/src/index.ts`](../packages/chain-config/src/index.ts):

- **`domain`** — used for canonical URLs, the sitemap, `robots.txt`, structured data, and
  the API's allowed CORS origin.
- **`peerUrl`** — where the network switcher sends visitors for the other chain.

The status page (`apps/status`) monitors bnbscan.com and ethscan.io; its targets are set
in `apps/status/src/server.ts`.

## Licence

Altscan is open source under [AGPL-3.0](../LICENSE). You may run it, modify it, and
charge for services around it. If you modify it and offer it to others over a network,
you must offer them your modified source. See [LICENSING.md](../LICENSING.md).
