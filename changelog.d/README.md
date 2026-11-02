# Unreleased changelog entries

Each user-facing PR adds one file here, so parallel PRs never conflict in `CHANGELOG.md`.

Name it `<PR number>.<section>.md`, for example `312.fixed.md`. The section is `added`, `changed`, `deprecated`, `removed`, `fixed` or `security`.

Write a bullet ending in the PR number:

```markdown
- **Token pages load faster.** Holder counts no longer block the first render (#312).
```

The entry appears on [altscan.io/changelog](https://altscan.io/changelog) within about an hour of merging. A release moves these entries into `CHANGELOG.md` with `node scripts/changelog-fragments.mjs --write`. See [Writing a changelog entry](../CONTRIBUTING.md#writing-a-changelog-entry).
