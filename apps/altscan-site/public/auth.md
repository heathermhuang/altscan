# Altscan auth.md

You are an agent. This document tells you which credentials the Altscan sites use and how to get one. Humans: see https://altscan.io.

## Nothing at altscan.io needs a credential

altscan.io issues no credentials and accepts none.

- MCP server: `https://altscan.io/mcp` (Streamable HTTP). No registration and no key: connect and call `tools/list`. It allows about 60 requests per minute per client IP and answers 429 above that.
- Chain status feed: `https://altscan.io/api/chains.json`. Keyless.

## Credentials for the explorers' APIs

The explorers, BNBScan (`bnbscan.com`) and EthScan (`ethscan.io`), issue API keys through anonymous registration: no account, email or identity provider, only a wallet signature (EIP-191 `personal_sign`) that binds the key to an EVM address you control. Their read endpoints are keyless too. A key gives you your own rate-limit budget instead of your IP's, and is required for webhooks.

Each explorer keeps its own keys: a key works only on the explorer that issued it, and never at altscan.io. The full flow, with the exact message to sign and the errors, is in each explorer's auth.md:

- https://bnbscan.com/auth.md
- https://ethscan.io/auth.md

In short, sign the message that document gives, then register:

```http
POST /api/v1/keys HTTP/1.1
Host: bnbscan.com
Content-Type: application/json

{"ownerAddress": "0xYourAddress", "label": "my-agent", "signature": "0x…", "timestamp": 1760000000000}
```

The response's `key` is the api_key credential, returned once. Send it to that explorer in the `X-API-Key` header.
