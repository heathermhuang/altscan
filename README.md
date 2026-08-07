<p align="center">
  <img src="docs/screenshots/bnbscan-homepage.png" alt="Altscan — BNBScan explorer" width="720" />
</p>

<h1 align="center">Altscan</h1>

<p align="center">
  The open-source, multi-chain block explorer platform.<br/>
  One codebase powers independent explorers for <strong>BNB Chain</strong> and <strong>Ethereum</strong> today — and is built to add more chains over time.<br/>
  Next.js 14, Drizzle ORM, and ethers.js. Maintained by <a href="https://mdt.io">Measurable Data Token (MDT)</a>.
</p>

<p align="center">
  <a href="https://altscan.io"><strong>altscan.io</strong></a> &nbsp;|&nbsp;
  <a href="https://bnbscan.com"><strong>bnbscan.com</strong></a> &nbsp;|&nbsp;
  <a href="https://ethscan.io"><strong>ethscan.io</strong></a>
</p>

<p align="center">
  <a href="https://github.com/heathermhuang/altscan/actions/workflows/ci.yml"><img src="https://github.com/heathermhuang/altscan/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
  <img src="https://img.shields.io/badge/Next.js-14-black?logo=next.js" alt="Next.js 14" />
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
│   ├── explorer/       Unified Next.js 14 frontend + API routes
│   │                   CHAIN=bnb → bnbscan.com
│   │                   CHAIN=eth → ethscan.io
│   ├── indexer/        Unified block indexer (direct polling loop)
│   │                   CHAIN=bnb → indexes BNB Chain
│   │                   CHAIN=eth → indexes Ethereum
│   └── status/         Independent Hono status page
│                       Polls /api/health on both sites
├── packages/
│   ├── chain-config/   getChainConfig() — chain-specific config
│   ├── db/             Drizzle ORM schema + Postgres client
│   ├── explorer-core/  Shared utils (rate limiting, formatting)
│   └── ui/             Shared React components
├── turbo.json          Turborepo pipeline config
└── pnpm-workspace.yaml
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), React 18, Tailwind CSS |
| Backend | Next.js API routes, Hono (status page) |
| Database | PostgreSQL (via Drizzle ORM) |
| Indexer | ethers.js, JSON-RPC (direct polling loop, no job queue) |
| Cache | Redis (rate limiting, Moralis CU ledger) |
| Monorepo | pnpm + Turborepo |
| Hosting | Render.com (web services + workers + Postgres + Redis) |

### How It Works

1. **Indexer** connects to a chain's JSON-RPC endpoint, polls for new blocks, and writes block/transaction/token data to Postgres via Drizzle ORM.
2. **Explorer** serves the Next.js frontend with ISR (Incremental Static Regeneration) — pages revalidate every 30s for fresh data without server pressure.
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

- **Node.js** 18+ 
- **pnpm** 10+
- **PostgreSQL** 14+
- **Redis** 6+ (for indexer job queues and rate limiting)

#### Installation

```bash
# Clone the repo
git clone https://github.com/heathermhuang/altscan.git
cd altscan

# Install dependencies
pnpm install

# Set up environment
cp apps/explorer/.env.example apps/explorer/.env.local

# Start all services (explorer + indexer via Turborepo)
pnpm dev
```

The BNB explorer will be available at `http://localhost:3000`.

### Running a specific chain

```bash
# BNB Chain explorer only
CHAIN=bnb pnpm --filter @altscan/explorer dev

# Ethereum explorer only
CHAIN=eth pnpm --filter @altscan/explorer dev -p 3001

# BNB indexer only
CHAIN=bnb pnpm --filter @altscan/indexer dev

# Status page only
npx tsx apps/status/src/server.ts
```

## Environment Variables

See `apps/explorer/.env.example` for the full list.

| Variable | Required | Description |
|----------|:--------:|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (BNB Chain) |
| `ETH_DATABASE_URL` | Yes | PostgreSQL connection string (Ethereum) |
| `BNB_RPC_URL` | Yes | BSC JSON-RPC endpoint |
| `ETH_RPC_URL` | Yes | Ethereum JSON-RPC endpoint |
| `REDIS_URL` | Yes | Redis connection string |
| `CHAIN` | Yes | `bnb` or `eth` — selects which chain to serve/index |
| `MORALIS_API_KEY` | No | Moralis API for balance and NFT enrichment |
| `GOPLUS_API_KEY` | No | GoPlus security analysis for token pages |
| `ADMIN_SECRET` | No | Bearer token for admin health/prune endpoints |

### Free RPC Endpoints

You can get started without paid RPC providers:

| Chain | Free Endpoint |
|-------|--------------|
| BNB Chain | `https://bsc-dataseed1.binance.org/` |
| Ethereum | `https://eth.llamarpc.com` |

For production, we recommend [Chainstack](https://chainstack.com) (Growth plan: 3M requests/month free).

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

Test suite covers IP spoofing prevention, SSRF protection, and rate limiting. See:
- `packages/explorer-core/src/rate-limit.test.ts`
- `apps/explorer/lib/webhook-ssrf.test.ts`

## Deployment

The project deploys to [Render.com](https://render.com) via `render.yaml`. Push to `main` triggers automatic deployment.

```bash
# Deploy (auto via Render on push)
git push origin main
```

### Production Configuration

| Service | Plan | Notes |
|---------|------|-------|
| `bnbscan-web` | Pro (2GB) | `CHAIN=bnb`, rootDir: `apps/explorer` |
| `ethscan-web` | Pro (2GB) | `CHAIN=eth`, rootDir: `apps/explorer` |
| `bnbscan-indexer` | Worker | `CHAIN=bnb`, 1-day body retention |
| `eth-indexer` | Worker | `CHAIN=eth`, 3-day body retention |
| BNB Postgres | Basic 1GB | 150GB disk, autoscaling off |
| ETH Postgres | Basic 1GB | 50GB disk, autoscaling off |

### Data Retention

Indexers prune **transaction bodies** on a rolling window (`RETENTION_DAYS`, default 7),
running cleanup every 6 hours. Transactions stay queryable — only the refetchable body is
dropped, and it is refetched on demand. Database size scales with chain throughput and
the window: BNB Chain writes roughly 12–15 GB per month at full retention, Ethereum 6–8 GB.

The production deployments run tighter windows than the default — 1 day on BNB, 3 on
Ethereum — because their disks are the binding constraint. Self-hosted installs default
to 7; see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#retention-and-disk).

To manually trigger cleanup:
```bash
curl -X POST "https://bnbscan.com/api/admin/db-prune?days=7" \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

## Known Limitations

- **Not a genesis archive** — the indexer advances forward from its start block. Older
  address and token history is fetched on demand from a provider and cached, rather than
  indexed locally. A full historical archive is a different architecture.
- **Deep history needs a Moralis key** — without one, address history is limited to
  locally indexed blocks and holder counts fall back to an estimate shown with a caveat.
  This is the only third-party commercial dependency.
- **Holder counts are eventually consistent** — recomputed every 5 minutes rather than
  per block, a deliberate trade for indexer throughput. Token pages can be briefly stale.
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
4. Run the test suite: `pnpm test`
5. Submit a pull request against `main`

First-time contributors: add your name to **[CONTRIBUTORS.md](CONTRIBUTORS.md)** in your
first PR to accept the **[Contributor License Agreement](CLA.md)**. You keep ownership of
your work — the CLA is a licence grant, not a copyright assignment, and it's what lets us
offer the commercial licence described below.

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
