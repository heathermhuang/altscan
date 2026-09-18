## What does this PR do?

<!-- A short summary of the change and the motivation behind it. -->

## Related issues

<!-- e.g. Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / tech debt
- [ ] Documentation
- [ ] Chore / tooling

## Affected surface

- [ ] Explorer UI (`apps/explorer`)
- [ ] Indexer (`apps/indexer`)
- [ ] Public REST API
- [ ] altscan.io site (`apps/altscan-site`)
- [ ] Shared packages
- [ ] Both chains (BNB + ETH)

## Checklist

- [ ] `pnpm test` passes
- [ ] `pnpm lint` and `pnpm --filter @altscan/explorer build` pass (or noted below why they don't apply)
- [ ] Changes match the surrounding code style
- [ ] Client components read chain config from the client helper (`@/lib/chain-client`), not server-only config
- [ ] Updated docs where relevant, and added a `CHANGELOG.md` line under `[Unreleased]` for user-facing changes
- [ ] Conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`…)

## Contributor License Agreement

First-time contributors: Altscan is dual licensed (see [LICENSING.md](../LICENSING.md)),
so we ask contributors to accept the [CLA](../CLA.md). You keep ownership of your work.

- [ ] I have added my name to [`CONTRIBUTORS.md`](../CONTRIBUTORS.md), or I am already listed there
