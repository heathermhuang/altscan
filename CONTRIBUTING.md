# Contributing to Altscan

Thanks for your interest in **Altscan** — the open-source, multi-chain block explorer platform powering [bnbscan.com](https://bnbscan.com) and [ethscan.io](https://ethscan.io).

## Development setup

```bash
git clone https://github.com/heathermhuang/altscan.git
cd altscan
pnpm install
cp apps/explorer/.env.example apps/explorer/.env.local   # fill in RPC + DB URLs
pnpm dev
```

The BNB explorer runs at `http://localhost:3000`.

## The `CHAIN` model

One codebase serves every chain. A single `CHAIN` environment variable (`bnb` or `eth`) selects which chain a deployment serves or indexes — same frontend, same indexer, same schema. Chain-specific differences (currency, theme, RPC, feature flags) live in [`packages/chain-config`](packages/chain-config). Client components must read chain config from the client helper (`@altscan/...`), never from server-only config.

Run a single chain/app:

```bash
CHAIN=bnb pnpm --filter @altscan/explorer dev         # BNB explorer
CHAIN=eth pnpm --filter @altscan/explorer dev -p 3001 # ETH explorer
CHAIN=bnb pnpm --filter @altscan/indexer dev          # BNB indexer
```

## Pull requests

1. Branch from `main`: `git checkout -b feat/my-feature`.
2. Keep changes focused and match the surrounding code style.
3. Run `pnpm test` and `pnpm build` before opening the PR.
4. Use conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`…).
5. Open the PR against `main` with a short description of what changed and why.

## Reporting issues

Open a GitHub issue with steps to reproduce, expected vs. actual behavior, and the chain/page affected. For security-sensitive reports, please disclose privately rather than in a public issue.

## Contributor License Agreement

Altscan is dual licensed: open source under [AGPL-3.0](LICENSE), plus a commercial
licence for organisations that cannot use AGPL code. See [LICENSING.md](LICENSING.md).

To keep that possible, contributions are accepted under our
[Contributor License Agreement](CLA.md). **You keep ownership of your work** — the CLA is
a licence grant, not a copyright assignment, and you remain free to use your
contributions anywhere else.

**To accept:** add your name to [`CONTRIBUTORS.md`](CONTRIBUTORS.md) in your first pull
request. That's the whole process — one line, no forms, no email. It covers every
contribution you make, then and later.

If you're contributing on behalf of an employer, please confirm you're authorised to do
so and note the organisation alongside your name.
