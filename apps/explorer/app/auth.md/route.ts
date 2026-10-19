import { NextResponse } from 'next/server'
import { chainConfig } from '@/lib/chain'
import { oauthConfig } from '@/lib/oauth'

// auth.md (https://workos.com/auth-md): how an agent gets and uses a credential here:
// audience, the provisioning endpoints, the methods, and how to send the credential.
// Every fact below is what app/api/v1/keys/route.ts, lib/api-auth.ts and lib/oauth.ts
// actually do; change them together. The OAuth section exists only while OAuth is on
// (OAUTH_SECRET), so this reads the runtime env on every request.

export const dynamic = 'force-dynamic'

function oauthSection(host: string): string {
  return `
## OAuth 2.1: the same access as a key, as a bearer token

This explorer also runs an OAuth 2.1 authorization server. Its access tokens work wherever an API key does, sent as \`Authorization: Bearer <access_token>\`, and count per address: 100 requests a minute, shared by every token for that address. They do not manage keys or webhooks; those still need \`X-API-Key\`. A token lasts one hour and works only on ${host}.

Discovery: the protected resource metadata at \`https://${host}/.well-known/oauth-protected-resource\` names the authorization server, whose metadata is at \`https://${host}/.well-known/oauth-authorization-server\`.

### With an API key: client_credentials

The key is the client secret, and its \`keyPrefix\` the client_id (HTTP Basic works too):

\`\`\`http
POST /oauth/token HTTP/1.1
Host: ${host}
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=bnbs_abc1234&client_secret=bnbs_…
\`\`\`

Response (200):

\`\`\`json
{"access_token": "…", "token_type": "Bearer", "expires_in": 3600, "scope": "api"}
\`\`\`

### Without a key: sign in with a wallet (authorization code + PKCE)

Register a public client:

\`\`\`http
POST /oauth/register HTTP/1.1
Host: ${host}
Content-Type: application/json

{"redirect_uris": ["http://127.0.0.1:8976/callback"], "client_name": "my-agent"}
\`\`\`

Make a PKCE pair (a 43-128 character \`code_verifier\`; \`code_challenge\` = base64url(SHA-256(code_verifier))) and load \`GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&scope=api\`. The page is for people with a browser wallet. An agent reads the JSON \`{"before": …, "after": …}\` inside \`<script type="application/json" id="m">\` and the form's hidden fields, signs \`before + address + after\` with \`personal_sign\`, and posts the hidden fields back with \`address\` and \`signature\` filled in:

\`\`\`http
POST /oauth/authorize HTTP/1.1
Host: ${host}
Content-Type: application/x-www-form-urlencoded

response_type=code&client_id=ac1.…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&scope=api&nonce=…&issued_at=…&state=…&address=0x…&signature=0x…
\`\`\`

The 303 to your redirect URI carries \`code\`, \`state\` and \`iss\`. Sign within 10 minutes of loading the page. Then exchange the code, once, within 60 seconds:

\`\`\`http
POST /oauth/token HTTP/1.1
Host: ${host}
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=…&client_id=ac1.…&redirect_uri=…&code_verifier=…
\`\`\`

There are no refresh tokens. A request with an altered or expired token answers 401 with \`WWW-Authenticate: Bearer resource_metadata="…", error="invalid_token"\`. The OAuth endpoints that mint something allow 20 requests a minute per IP.
`
}

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
${oauthConfig() ? oauthSection(host) : ''}`
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
