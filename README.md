<p align="center">
  <img src="docs/screenshots/bnbscan-homepage.png" alt="Altscan — BNBScan explorer" width="720" />
</p>

<h1 align="center">Altscan</h1>

<p align="center">
  The open-source, multi-chain block explorer platform.<br/>
  One codebase powers independent explorers for <strong>BNB Chain</strong> and <strong>Ethereum</strong> today — and is built to add more chains over time.<br/>
  Next.js 15, Drizzle ORM, and ethers.js. Maintained by <a href="https://mdt.io">Measurable Data Token (MDT)</a>.
</p>

<p align="center">
  <a href="https://altscan.io"><strong>altscan.io</strong></a> &nbsp;|&nbsp;
  <a href="https://bnbscan.com"><strong>bnbscan.com</strong></a> &nbsp;|&nbsp;
  <a href="https://ethscan.io"><strong>ethscan.io</strong></a>
</p>

<p align="center">
  <a href="https://github.com/heathermhuang/altscan/actions/workflows/ci.yml"><img src="https://github.com/heathermhuang/altscan/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/heathermhuang/altscan/actions/workflows/codeql.yml"><img src="https://github.com/heathermhuang/altscan/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://github.com/heathermhuang/altscan/releases/latest"><img src="https://img.shields.io/github/v/release/heathermhuang/altscan" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
  <img src="https://img.shields.io/badge/Next.js-15-black?logo=next.js" alt="Next.js 15" />
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome" /></a>
</p>

---

## What is this?

**Altscan** is an open-source, multi-chain block explorer platform. One codebase powers two independent explorers today — **BNBScan** ([bnbscan.com](https://bnbscan.com), BNB Chain) and **EthScan** ([ethscan.io](https://ethscan.io), Ethereum) — and is designed to extend to more chains over time. They are fully independent from BscScan, Etherscan, Binance, or the Ethereum Foundation, providing a clean, fast interface for exploring blocks, transactions, addresses, tokens, and on-chain activity.

A single `CHAIN` environment variable selects which chain a deployment serves — same frontend, same indexer, same schema.

## Screenshots

| Homepage | Blocks |
|:---:|:---:|
| ![Homepage](docs/screenshots/bnbscan-homepage.png) | ![Blocks](docs/screenshots/bnbscan-blocks.png) |

| DEX Trades | Status Page |
|:---:|:---:|
| ![DEX](docs/screenshots/bnbscan-dex.png) | ![Status](docs/screenshots/status-page.png) |

> **Note:** To regenerate screenshots, visit the live sites and save full-page captures to `docs/screenshots/`.

## Features

### Exploration
- **Blocks** — browse the latest blocks with miner, gas, and transaction counts
- **Transactions** — full transaction details with internal calls, logs, and token transfers
- **Addresses** — balance overview, transaction history, token holdings, and NFT portfolio
- **Tokens** — ERC-20 token pages with holder lists, transfers, and price data

### Analytics
- **DEX Trade Tracker** — real-time PancakeSwap (BNB) and Uniswap V2/V3 (ETH) trades
- **Whale Tracker** — large transfers and top holder analysis
- **Gas Tracker** — current gas prices, historical gas price charts
- **Network Charts** — daily transaction counts, block size trends, and more

### Developer Tools
- **Contract Verification** — verify and read contracts via Sourcify integration
- **REST API** — v1 query API with key management and webhook support
- **CSV Export** — export transaction history for any address
- **Network Switcher** — one-click toggle between BNB Chain and Ethereum

### Infrastructure
- **Validators** (BNB) — active validator list with block production stats
- **Watchlist** — save addresses and get alerts
- **Independent Status Page** — real-time uptime, block lag, and response time monitoring

## Architecture

```
altscan/
├── apps/
│   ├── explorer/         Unified Next.js 15 frontend + API routes
│   │                     CHAIN=bnb → bnbscan.com
│   │                     CHAIN=eth → ethscan.io
│   ├── indexer/          Unified block indexer (direct polling loop)
│   │                     CHAIN=bnb → indexes BNB Chain
│   │                     CHAIN=eth → indexes Ethereum
│   ├── status/           Independent Hono status page
│   │                     Polls /api/health on both sites
│   ├── altscan-site/     altscan.io umbrella site (Astro on Cloudflare Workers)
│   └── admin/            Operator console behind Cloudflare Access (Astro on Cloudflare Workers)
├── packages/
│   ├── chain-config/     getChainConfig() — chain-specific config
│   ├── db/               Drizzle ORM schema + Postgres client
│   ├── explorer-core/    Shared utils (rate limiting, formatting, Redis cache)
│   ├── providers/        Third-party data adapters (Moralis) and their spend budgets
│   ├── settings-schema/  Runtime settings shared by the explorer and the admin console
│   └── types/            Shared TypeScript types
├── render.yaml           Render blueprint for the hosted explorers
├── docker-compose.yml    Self-host stack: Postgres, Redis, indexer, explorer
├── turbo.json            Turborepo pipeline config
└── pnpm-workspace.yaml
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 (App Router), React 19, Tailwind CSS 3 |
| Backend | Next.js API routes, Hono (status page) |
| Database | PostgreSQL (via Drizzle ORM) |
| Indexer | ethers.js, JSON-RPC (direct polling loop, no job queue) |
| Cache | Redis (rate limiting, caching, Moralis CU ledger) |
| Edge sites | Astro on Cloudflare Workers (altscan.io, admin console) |
| Monorepo | pnpm + Turborepo |
| Hosting | Render.com (web services + workers + Postgres + Redis) |

### How It Works

1. **Indexer** connects to a chain's JSON-RPC endpoint, polls for new blocks, and writes block/transaction/token data to Postgres via Drizzle ORM.
2. **Explorer** serves the Next.js frontend with ISR (Incremental Static Regeneration) — each page revalidates on its own schedule, from 45 seconds to an hour, for fresh data without server pressure.
3. **Chain Config** package centralizes all chain-specific differences (block time, currency, theme colors, RPC URLs, feature flags) so the same code runs both chains.
4. **Status Page** independently monitors both explorers by polling their `/api/health` endpoints every 30 seconds, tracking uptime, block lag, and response time with a 24-hour timeline.

## Getting Started

### Run your own explorer (Docker)

```bash
git clone https://github.com/heathermhuang/altscan.git
cd altscan
cp .env.docker.example .env
docker compose up -d
```

Open <http://localhost:3000>. That's Postgres, Redis, the indexer, and the explorer —
no configuration required to start, and the indexer creates its own schema on first
boot. Set `CHAIN=eth` in `.env` and re-run with `--build` for Ethereum.

Full guide, including Render deployment, retention tuning, and limitations:
**[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

### Develop locally (without Docker)

#### Prerequisites

- **Node.js** 22 — what CI, the Docker images, and the hosted explorers run
- **pnpm** 10 — pinned in `package.json`; `corepack enable` picks up the exact version
- **PostgreSQL** 16
- **Redis** 7 — optional: without `REDIS_URL`, rate limits and caches fall back to per-process memory

#### Installation

```bash
# Clone the repo
git clone https://github.com/heathermhuang/altscan.git
cd altscan

# Install dependencies
pnpm install

# Set up environment
cp apps/explorer/.env.example apps/explorer/.env.local

# Start the BNB explorer
CHAIN=bnb NEXT_PUBLIC_CHAIN=bnb pnpm --filter @altscan/explorer dev
```

The BNB explorer will be available at `http://localhost:3000`. `pnpm dev` starts every
app at once through Turborepo: the explorer, the indexer, the status page, and both
Astro sites.

### Running a specific chain

```bash
# BNB Chain explorer only
CHAIN=bnb NEXT_PUBLIC_CHAIN=bnb pnpm --filter @altscan/explorer dev

# Ethereum explorer only
CHAIN=eth NEXT_PUBLIC_CHAIN=eth pnpm --filter @altscan/explorer dev -p 3001

# BNB indexer only
CHAIN=bnb pnpm --filter @altscan/indexer dev

# Status page only
npx tsx apps/status/src/server.ts
```

`CHAIN` drives the server; `NEXT_PUBLIC_CHAIN` is inlined into the client bundle, so set
both to the same chain.

## Environment Variables

See `apps/explorer/.env.example` for the full list.

| Variable | Required | Description |
|----------|:--------:|-------------|
| `CHAIN` | Yes | `bnb` or `eth` — selects which chain to serve/index |
| `NEXT_PUBLIC_CHAIN` | Explorer | Same value as `CHAIN`; read by client components at build time |
| `DATABASE_URL` | `CHAIN=bnb` | PostgreSQL connection string (BNB Chain) |
| `ETH_DATABASE_URL` | `CHAIN=eth` | PostgreSQL connection string (Ethereum) |
| `BNB_RPC_URL` | `CHAIN=bnb` | BSC JSON-RPC endpoint, or a comma-separated list for failover |
| `ETH_RPC_URL` | `CHAIN=eth` | Ethereum JSON-RPC endpoint, or a comma-separated list for failover |
| `REDIS_URL` | Recommended | Redis connection string; without it, rate limits and caches are per-process |
| `MORALIS_API_KEY` | No | Moralis API for balance and NFT enrichment |
| `GOPLUS_API_KEY` | No | GoPlus security analysis for token pages |
| `ADMIN_SECRET` | No | Bearer token for admin health/prune endpoints |

### Free RPC Endpoints

You can get started without paid RPC providers:

| Chain | Free Endpoint |
|-------|--------------|
| BNB Chain | `https://bsc-dataseed1.binance.org/` |
| Ethereum | `https://eth.drpc.org` |

Both serve `eth_getBlockReceipts` for historical blocks, which the indexer depends on
(checked September 2026). Check any other endpoint the same way — ask it for the receipts
of a block a few thousand deep — before you rely on it. Some public RPCs answer at the
chain tip but lack that method, and some return an empty list instead of an error, which
silently drops a block's token transfers.

For production, use a paid RPC provider: free endpoints rate-limit under indexer load.

## API

Both explorers expose a v1 REST API. Visit `/api-docs` on either site for interactive documentation, or `/developer` to create an API key.

```bash
# Example: query transactions for an address
curl -X POST https://bnbscan.com/api/v1/query \
  -H "X-API-Key: bnbs_..." \
  -H "Content-Type: application/json" \
  -d '{"entity":"transactions","filter":{"address":"0x..."}}'
```

## Testing

```bash
pnpm test
```

Runs the Vitest suite for every workspace. Suites that need a real Postgres or Redis are
skipped unless their environment variable is set —
[CONTRIBUTING.md](CONTRIBUTING.md#tests-that-need-postgres-or-redis) lists them and how to
run them. CI also runs those suites, lint, an indexer typecheck, and a production build of
the explorer.

## Deployment

The hosted explorers run on [Render.com](https://render.com) from
[`render.yaml`](render.yaml): a web service and an indexer worker per chain, with Postgres
and Redis. To run your own, with Docker or on Render, follow
**[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

### Data Retention

Indexers prune **transaction bodies** on a rolling window (`RETENTION_DAYS`, default 7),
running cleanup every 6 hours. Transactions stay queryable — only the refetchable body is
dropped, and it is refetched on demand. Database size scales with chain throughput and
the window: BNB Chain writes roughly 12–15 GB per month at full retention, Ethereum 6–8 GB.
Size the window to your disk; see
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#retention-and-disk).

To manually trigger cleanup:
```bash
curl -X POST "https://your-explorer.example/api/admin/db-prune?days=7" \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

## Known Limitations

- **Not a genesis archive** — the indexer advances forward from its start block. Older
  address and token history is fetched on demand from a provider and cached, rather than
  indexed locally. A full historical archive is a different architecture.
- **Deep history needs a Moralis key** — without one, address history is limited to
  locally indexed blocks and holder counts fall back to an estimate shown with a caveat.
  This is the only third-party commercial dependency.
- **Holder counts are eventually consistent** — recomputed every 15 minutes by default
  (`HOLDER_COUNT_INTERVAL_MIN`) rather than per block, a deliberate trade for indexer
  throughput. Token pages can be briefly stale.
- **One chain per deployment** — `NEXT_PUBLIC_CHAIN` is inlined into the client bundle at
  build time, so switching chains requires a rebuild, not just a restart.
- **Two chains supported** — BNB Chain and Ethereum. Adding a third currently requires
  code changes rather than configuration.
- **Contract verification is Sourcify-only.**
- **Bot detection disabled** — turned off to enable ISR caching.

## Contributing

Contributions are welcome. Please read **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, the `CHAIN` model, and PR conventions, and our **[Code of Conduct](CODE_OF_CONDUCT.md)**.

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes and add tests
4. Run the checks listed in [CONTRIBUTING.md](CONTRIBUTING.md#before-you-open-a-pull-request)
5. Submit a pull request against `main`

First-time contributors: add your name to **[CONTRIBUTORS.md](CONTRIBUTORS.md)** in your
first PR to accept the **[Contributor License Agreement](CLA.md)**. You keep ownership of
your work — the CLA is a licence grant, not a copyright assignment, and it's what lets us
offer the commercial licence described below. A CI check confirms you're listed.

Found a security vulnerability? Please follow our **[Security Policy](SECURITY.md)** — do not open a public issue.

## License

**Open source under [AGPL-3.0](LICENSE)** — an OSI-approved licence. Free, forever, for
everyone:

- **Run it** for any purpose, including commercially and as a paid service
- **Fork it**, modify it, and distribute your fork
- **Sell services around it** — hosting, support, consulting, managed deployments, RaaS
- The grant is **irrevocable** — published releases stay AGPL-3.0, and we cannot take
  that back

AGPL asks one thing in return: if you modify Altscan and offer it to others over a
network, offer those users your modified source too. Run it unmodified, or keep your
changes internal, and you owe nothing.

A **commercial licence** is available for organisations that cannot use AGPL code or need
warranty and support terms. See **[LICENSING.md](LICENSING.md)** for what that covers and
how the terms compare to source-available alternatives.

© Measurable Data Token (MDT).
