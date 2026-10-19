import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'

// auth.md (https://workos.com/auth-md): how an agent gets and uses a credential here.
// There is no OAuth server, so this is the self-contained form: audience, the
// provisioning endpoint, the method, and how to send the credential. Every fact
// below is what app/api/v1/keys/route.ts and lib/api-auth.ts actually do; change
// them together.

export const revalidate = 3600

function authMdBody(): string {
  const c = chainConfig
  const host = c.domain
  return `# ${c.brandDomain} auth.md

You are an agent. This document tells you how to get and use a credential for the ${c.brandDomain} API (\`https://${host}\`), a public ${c.name} explorer. Humans: see https://${host}/developer.

## Do you need a credential?

Usually not. The chain-data endpoints under \`/api/v1\` (blocks, transactions, addresses, tokens, contracts, stats, query) are public and keyless, limited to 100 requests per minute per IP. The OpenAPI description is at https://${host}/openapi.json.

An API key does two things:

- On the endpoints that take one (\`/api/v1/query\`, \`/api/v1/keys\`, \`/api/v1/webhooks\` and \`/api/v1/contracts/{address}/call\`), a request with a valid key counts against that key's own budget of 100 requests per minute instead of your IP's.
- Webhooks and key listing require it: every \`/api/v1/webhooks\` call and \`GET /api/v1/keys\` answer 401 without one. Only registering an address's first key needs none.

A key works only on ${host}. Each Altscan explorer keeps its own keys.

## Registration method: anonymous, by wallet signature

There is no account, email or identity provider. You prove control of an EVM address by signing a message with its private key (EIP-191 \`personal_sign\`), and the key is bound to that address. A freshly generated keypair works. Only sign with a wallet you are authorized to use.

### Step 1: sign

Sign this exact string: three lines joined by \`\\n\`, the address in lowercase, the timestamp in Unix milliseconds.

\`\`\`text
BNBScan API Key Request
Address: 0xyouraddress
Timestamp: 1760000000000
\`\`\`

The first line is the same on every Altscan explorer.

### Step 2: register

\`\`\`http
POST /api/v1/keys HTTP/1.1
Host: ${host}
Content-Type: application/json

{"ownerAddress": "0xYourAddress", "label": "my-agent", "signature": "0x…", "timestamp": 1760000000000}
\`\`\`

Signatures older than 5 minutes are rejected. If the address already has a key, also send one of its keys in \`X-API-Key\`. An address can hold at most 10 keys.

Response (201):

\`\`\`json
{"id": 1, "key": "bnbs_…", "keyPrefix": "bnbs_…", "message": "API key created. Save it now — the full key will not be shown again. Pass it as X-API-Key header."}
\`\`\`

\`key\` is the api_key credential. It is returned exactly once: store it as a secret and do not log it.

## Step 3: use the credential

Send the key in the \`X-API-Key\` header (not \`Authorization: Bearer\`):

\`\`\`http
POST /api/v1/query HTTP/1.1
Host: ${host}
X-API-Key: bnbs_…
Content-Type: application/json

{"entity": "blocks", "limit": 5}
\`\`\`

List your keys with \`GET /api/v1/keys?owner=0xYourAddress\` and the same header.

## Errors

| Status | Meaning | What to do |
| ------ | ------- | ---------- |
| 400 | Invalid \`ownerAddress\`, missing or expired signature, unparseable signature, or the 10-key limit | Fix the request; re-sign with a fresh timestamp |
| 401 | \`X-API-Key\` missing where the address already has a key, or the key is invalid or inactive | Send a valid key of that address |
| 403 | The signature was not made by \`ownerAddress\`, or the key belongs to another address | Sign with the matching wallet |
| 429 | Rate limit | Back off and retry after a minute |

There is no self-service revocation endpoint. Discard a key you no longer need.
`
}

export async function GET() {
  return new NextResponse(authMdBody(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
