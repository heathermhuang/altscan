# Security Policy

Altscan powers public block explorers ([bnbscan.com](https://bnbscan.com), [ethscan.io](https://ethscan.io)) and a public REST API, so we take the security of the platform and its users seriously.

## Supported versions

Altscan is deployed continuously from `main`. The latest state of `main` is the only supported version; fixes are not back-ported to older tags.

| Version | Supported |
|---------|:---------:|
| `main` (latest) | ✅ |
| Older tags | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use one of these private channels:

- **GitHub Security Advisories** — [open a private report](https://github.com/heathermhuang/altscan/security/advisories/new) (preferred)
- **Email** — [bnbscan@mdt.io](mailto:bnbscan@mdt.io)

Please include:

- A description of the issue and its potential impact
- Steps to reproduce — a proof-of-concept, the affected URL or API endpoint, and the chain (BNB or Ethereum) where relevant
- Any relevant logs, payloads, or screenshots

## What to expect

- **Acknowledgement** within 3 business days.
- **Triage** with a severity assessment and a remediation plan.
- **Fix & disclosure** — we aim to ship fixes promptly and are happy to credit reporters who wish to be named once a fix is deployed.

## Scope

**In scope:** the explorer app (`apps/explorer`), the indexer (`apps/indexer`), the public REST API, and the `altscan-site` umbrella site in this repository.

**Out of scope:** findings that require physical access or social engineering; volumetric denial-of-service; and vulnerabilities in third-party providers (RPC nodes, Moralis, Cloudflare, Render) — please report those to the respective vendor.

A machine-readable contact is also published at `/.well-known/security.txt` on each explorer.
