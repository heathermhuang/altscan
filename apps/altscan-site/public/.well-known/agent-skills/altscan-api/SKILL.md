---
name: altscan-api
description: "Query BNB Chain or Ethereum data through Altscan's free explorers: pick bnbscan.com or ethscan.io by chain, then call the same keyless REST API on either (blocks, transactions, addresses, tokens, contracts)."
---

# Altscan explorers — which one, and how to query it

Altscan is one open-source explorer engine running a separate explorer per chain. Each explorer serves
the same public REST API, so code written for one works on the other with a different base URL.

## Pick the explorer by chain

| Chain | chainId | Explorer | API base |
|---|---|---|---|
| BNB Chain | 56 | https://bnbscan.com | https://bnbscan.com/api/v1 |
| Ethereum | 1 | https://ethscan.io | https://ethscan.io/api/v1 |

There is no Altscan explorer for other chains. Do not send an address or hash for one chain to the
other chain's explorer: the API returns "not found" rather than an error that names the chain.

## Calling the API

- No API key, no auth. Rate limits are per client IP; on HTTP 429, back off and retry later.
- Every response is JSON. Common starting points:
  - `GET /api/v1/stats` — latest block, transaction and token counts, average gas price
  - `GET /api/v1/transactions/{hash}` — one transaction, with its status and gas used
  - `GET /api/v1/addresses/{address}` — the address's 20 latest indexed transactions and token transfers,
    and `isContract`; when `isContractKnown` is false the contract check failed and `isContract` means nothing
  - `GET /api/v1/tokens/{contract}` — token metadata
- The full endpoint list, kept in step with the code, is each explorer's own skill:
  `/.well-known/agent-skills/api-usage/SKILL.md`, plus its RFC 9727 catalog at
  `/.well-known/api-catalog` and human docs at `/api-docs`.

## Limits to know

- Indexed history is recent. A transaction older than the explorer's retention window can be missing
  even though it exists on chain. Treat "not found" for an old hash as "not indexed", not "never happened".
- Token holder counts are an indexed snapshot, labelled "indexed holders" on the sites, and are lower
  than the true holder count.

## Live status

`https://altscan.io/api/chains.json` returns each explorer's latest indexed block and its recent blocks,
cached for 12 seconds. Use it to check that an explorer is current before trusting a "latest" answer.
