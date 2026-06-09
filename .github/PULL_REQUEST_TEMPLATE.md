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
- [ ] `pnpm build` passes (or noted below why it doesn't apply)
- [ ] Changes match the surrounding code style
- [ ] Client components read chain config from the client helper (`@/lib/chain-client`), not server-only config
- [ ] Updated docs and `CHANGELOG.md` where relevant
- [ ] Conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`…)
