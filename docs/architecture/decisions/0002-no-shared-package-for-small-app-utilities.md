# 0002. Small utilities stay per app; a shared package is for a shared contract

Date: 2026-11-28 · Status: accepted

## Context

The indexer and the explorer each have a `withTimeout`, and both validate addresses with
a regex. The indexer depends on neither `@altscan/explorer-core` nor any app code. Sharing
a ten-line helper would need a new edge in the workspace graph, and the two copies differ
on purpose: the indexer's error text is part of its RPC failover logging vocabulary, while
the explorer's is the page-level "query timeout".

## Decision

Within an app, one implementation (ADR 0001). Across apps, a utility is shared only when
it encodes a contract both sides must agree on: a data shape both read (`packages/db`),
a security control (`sanitizeSymbol` in `explorer-core`), or a protocol (`packages/oauth`).
A small helper with no shared contract stays in each app.

## Consequences

- Two `withTimeout`s exist (indexer `src/rpc-failover.ts`, explorer `lib/with-timeout.ts`).
  This is the documented exception, not drift.
- Before moving something into a package, ask whether a disagreement between the two
  copies would be a bug. If it would, share it. If not, leave it.
