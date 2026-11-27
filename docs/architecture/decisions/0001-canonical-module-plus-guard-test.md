# 0001. Each cross-cutting concern has one module, and a test that rejects a second

Date: 2026-11-28 · Status: accepted

## Context

The explorer had grown parallel copies of small rules: 30 inline address/hash regexes in
five spellings with two different case rules, three `withTimeout`s, seven hand-rolled TTL
caches (two of them invisible to `/api/health`), and a dead package declared by two apps.
None of them was wrong when written. They drifted because nothing stopped the next copy.

## Decision

When a concern gets a canonical module, the same change:

1. migrates every caller, keeping each caller's exact behavior (or naming the deliberate
   difference in the commit);
2. deletes the replaced copies;
3. adds a guard test next to the module that scans the workspace's source and fails on a
   new copy, with a positive control so the scan cannot pass vacuously (it must find the
   canonical module itself, or the spellings it bans).

Guards are plain vitest files using `readdirSync`/`git ls-files`, matching the existing
`ip-bucket-callers.test.ts` style. No new lint tooling.

## Consequences

- A second implementation fails CI with a message naming the canonical module.
- The guards are text scans, so they can be fooled on purpose. They exist to stop drift,
  not to resist an adversary.
- A guard's allow-list is where an exception gets reviewed, e.g. `registerCache` remaining
  legal for the kv-cache fallback, which is not a TTL map.
