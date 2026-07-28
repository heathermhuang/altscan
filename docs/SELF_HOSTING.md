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
this anywhere other than your laptop.

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
`EXPLORER_PORT` and `POSTGRES_PORT` values, or two Render blueprints.

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
[`apps/explorer/.env.example`](../apps/explorer/.env.example).

This is the one place Altscan depends on a third-party commercial service. Everything
else runs from your own node/RPC and your own database.

## Retention and disk

```bash
RETENTION_DAYS=7    # default
```

Transaction bodies older than this are pruned; the transactions themselves remain
queryable, and bodies are refetched on demand. BNB Chain writes roughly **12–15 GB per
month** at full retention, Ethereum roughly **6–8 GB**. Check free disk before raising
this.

The indexer logs table sizes and disk usage on each retention pass. Set `DB_DISK_GB` to
your actual disk size to get a warning at 70% capacity.

## Deploying on Render

A single-chain template lives at
[`deploy/render/blueprint.yaml`](../deploy/render/blueprint.yaml).

```bash
cp deploy/render/blueprint.yaml render.yaml
```

Commit that to your fork, then in Render: **New → Blueprint → select your fork**. Set
the RPC URL and `START_BLOCK` when prompted.

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

There is no migration step. The indexer creates and updates its own schema on boot via
[`ensure-schema.ts`](../apps/indexer/src/ensure-schema.ts), including the partitioned
`token_transfers` table. Point it at an empty database and it will do the rest.

> The root `schema.sql` is a stale hand-maintained snapshot predating several tables and
> is **not** the bootstrap path. Don't apply it to a fresh database.

```bash
docker compose exec postgres psql -U altscan -d altscan
```

## Troubleshooting

**The homepage looks empty on first load, but `/blocks` has data.**
Expected. The homepage is cached with a 30-second ISR window and ships prerendered
against an empty database. The first request after that window serves the stale copy and
triggers regeneration in the background; the next one shows live data. Reload once.

**`rate limit` / `-32005` errors in the indexer logs.**
The default RPC endpoints are free public nodes and will throttle a catching-up indexer.
Failed blocks are retried, so it self-corrects, but throughput suffers. Lower
`INDEX_CONCURRENCY`, or use a dedicated provider endpoint.

**The indexer says `N blocks behind — skipping to block X`.**
Normal when it falls more than 1000 blocks behind: it jumps forward to stay near the head
rather than grinding through the gap. Lower `START_BLOCK_LOOKBACK` or raise
`INDEX_CONCURRENCY` if you want the gap filled.

**Wrong currency symbol or theme after switching chains.**
You restarted without rebuilding. Run `docker compose up -d --build` — see
[Choosing a chain](#choosing-a-chain).

```bash
docker compose logs -f indexer     # indexing progress and errors
docker compose logs -f explorer    # request-level errors
docker compose ps                  # health status of all four services
```

## Limitations

Worth knowing before you commit to this:

- **No genesis archive.** Altscan indexes forward from your start block, with on-demand
  provider backfill for older address/token history. It is not a full archive node
  explorer.
- **One chain per stack**, for the build-time reason above.
- **Contract verification** is via Sourcify only.
- **Two chains supported** today (BNB, Ethereum). Adding a third currently requires code
  changes, not configuration.

## Licence

Altscan is open source under [AGPL-3.0](../LICENSE). You may run it, modify it, and
charge for services around it. If you modify it and offer it to others over a network,
you must offer them your modified source. See [LICENSING.md](../LICENSING.md).
