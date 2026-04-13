<p align="center">
  <img src="docs/screenshots/bnbscan-homepage.png" alt="BNBScan Homepage" width="720" />
</p>

<h1 align="center">BNBScan &amp; EthScan</h1>

<p align="center">
  Open-source, independent block explorers for <strong>BNB Chain</strong> and <strong>Ethereum</strong>.<br/>
  Built with Next.js 14, Drizzle ORM, and ethers.js. Maintained by <a href="https://mdt.io">Measurable Data Token (MDT)</a>.
</p>

<p align="center">
  <a href="https://bnbscan.com"><strong>bnbscan.com</strong></a> &nbsp;|&nbsp;
  <a href="https://ethscan.io"><strong>ethscan.io</strong></a> &nbsp;|&nbsp;
  <a href="https://status-page-6ez4.onrender.com"><strong>Status Page</strong></a>
</p>

---

## What is this?

BNBScan and EthScan are **alternative block explorers** — fully independent from BscScan, Etherscan, Binance, or the Ethereum Foundation. They provide a clean, fast interface for exploring blocks, transactions, addresses, tokens, and on-chain activity.

Both explorers run from **one unified codebase**. A single `CHAIN` environment variable switches between BNB Chain and Ethereum — same frontend, same indexer, same schema.

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
bnbscan/
├── apps/
│   ├── explorer/       Unified Next.js 14 frontend + API routes
│   │                   CHAIN=bnb → bnbscan.com
│   │                   CHAIN=eth → ethscan.io
│   ├── indexer/        Unified BullMQ block indexer
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
| Indexer | BullMQ, ethers.js, JSON-RPC |
| Cache | Redis (rate limiting, job queues) |
| Monorepo | pnpm + Turborepo |
| Hosting | Render.com (web services + workers + Postgres + Redis) |

### How It Works

1. **Indexer** connects to a chain's JSON-RPC endpoint, polls for new blocks, and writes block/transaction/token data to Postgres via Drizzle ORM.
2. **Explorer** serves the Next.js frontend with ISR (Incremental Static Regeneration) — pages revalidate every 30s for fresh data without server pressure.
3. **Chain Config** package centralizes all chain-specific differences (block time, currency, theme colors, RPC URLs, feature flags) so the same code runs both chains.
4. **Status Page** independently monitors both explorers by polling their `/api/health` endpoints every 30 seconds, tracking uptime, block lag, and response time with a 24-hour timeline.

## Getting Started

### Prerequisites

- **Node.js** 18+ 
- **pnpm** 10+
- **PostgreSQL** 14+
- **Redis** 6+ (for indexer job queues and rate limiting)

### Installation

```bash
# Clone the repo
git clone https://github.com/nicemdt/bnbscan.git
cd bnbscan

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
CHAIN=bnb pnpm --filter @bnbscan/explorer dev

# Ethereum explorer only
CHAIN=eth pnpm --filter @bnbscan/explorer dev -p 3001

# BNB indexer only
CHAIN=bnb pnpm --filter @bnbscan/indexer dev

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
- `apps/web/lib/webhook-ssrf.test.ts`

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
| `bnbscan-indexer` | Worker | `CHAIN=bnb`, 7-day data retention |
| `eth-indexer` | Worker | `CHAIN=eth`, 7-day data retention |
| BNB Postgres | Basic 4GB | 50GB disk, autoscaling off |
| ETH Postgres | Basic 1GB | 50GB disk, autoscaling off |

### Data Retention

Indexers enforce a **7-day rolling retention** window, running cleanup every 6 hours. Database size stays around 25-30GB per chain.

To manually trigger cleanup:
```bash
curl -X POST "https://bnbscan.com/api/admin/db-prune?days=7" \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

## Known Limitations

- **No reorg handling** — indexers advance by block height without canonical chain validation
- **Token balances not live-updated** — holder counts and balances refresh on indexer pass
- **Per-process rate limiting** — not Redis-backed; may allow bypass under auto-scaling
- **Historical coverage** — starts from a recent block, not genesis
- **Bot detection disabled** — turned off to enable ISR caching

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes and add tests
4. Run the test suite: `pnpm test`
5. Submit a pull request

## License

MIT
