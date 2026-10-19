# Altscan auth.md

You are an agent. This document tells you which credentials the Altscan sites use and how to get one. Humans: see https://altscan.io.

## altscan.io: nothing needs a credential, and a token is optional

- MCP server: `https://altscan.io/mcp` (Streamable HTTP). No registration and no key: connect and call `tools/list`. It allows about 60 requests per minute per client IP and answers 429 above that. With an OAuth access token, the same limit counts per address instead of per IP.
- Chain status feed: `https://altscan.io/api/chains.json`. Keyless.

## Getting a token: OAuth 2.1, signed with a wallet

altscan.io runs its own OAuth 2.1 authorization server. Its only identity is an EVM address you prove by signing a message (EIP-191 `personal_sign`). This is anonymous registration: there is no account, email or identity provider, and a freshly generated keypair works. Only sign with a wallet you are authorized to use.

Discovery: the protected resource metadata at `https://altscan.io/.well-known/oauth-protected-resource` names the authorization server, whose metadata is at `https://altscan.io/.well-known/oauth-authorization-server`. MCP clients that implement MCP authorization do these steps themselves.

### Step 1: register a client

```http
POST /oauth/register HTTP/1.1
Host: altscan.io
Content-Type: application/json

{"redirect_uris": ["http://127.0.0.1:8976/callback"], "client_name": "my-agent"}
```

Response (201): `{"client_id": "ac1.…", "token_endpoint_auth_method": "none", …}`. Only public clients register. A redirect URI must be https, http on loopback, or a private-use scheme.

### Step 2: sign the authorization request

Make a PKCE pair: a `code_verifier` of 43-128 characters and `code_challenge` = base64url(SHA-256(code_verifier)). Then load the authorization page:

```http
GET /oauth/authorize?response_type=code&client_id=ac1.…&redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback&state=…&code_challenge=…&code_challenge_method=S256&scope=mcp HTTP/1.1
Host: altscan.io
```

The page is for people with a browser wallet. An agent reads two things from it: the JSON `{"before": …, "after": …}` inside `<script type="application/json" id="m">`, and the form's hidden `<input>` fields. Sign the string `before + address + after` with `personal_sign`, where `address` is your 0x address, and post every hidden field back with `address` and `signature` filled in:

```http
POST /oauth/authorize HTTP/1.1
Host: altscan.io
Content-Type: application/x-www-form-urlencoded

response_type=code&client_id=ac1.…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&scope=mcp&nonce=…&issued_at=…&state=…&address=0x…&signature=0x…
```

The answer is a 303 to your redirect URI carrying `code`, `state` and `iss`. You don't have to follow it. Sign within 10 minutes of loading the page.

### Step 3: exchange the code

```http
POST /oauth/token HTTP/1.1
Host: altscan.io
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=…&client_id=ac1.…&redirect_uri=…&code_verifier=…
```

Response (200):

```json
{"access_token": "…", "token_type": "Bearer", "expires_in": 3600, "scope": "mcp"}
```

A code works once, within 60 seconds. There are no refresh tokens: sign in again after the hour.

### Step 4: use the credential

Send `Authorization: Bearer <access_token>` with each `POST https://altscan.io/mcp`. The access_token credential works only at altscan.io.

## Errors

| Status | Where | Meaning | What to do |
| ------ | ----- | ------- | ---------- |
| 400 | `/oauth/register` | `invalid_redirect_uri` or `invalid_client_metadata` | Fix the redirect URIs; register as a public client |
| 400 | `/oauth/authorize` | An error page: unknown `client_id`, or a `redirect_uri` it did not register | Register first; use a registered redirect URI |
| 303 | `/oauth/authorize` | `error=access_denied` (signature does not match, or older than 10 minutes), `invalid_request` (no S256 PKCE), `invalid_scope` | Reload the page and sign again; send PKCE; use scope `mcp` |
| 400 | `/oauth/token` | `invalid_grant`: the code is unknown, used, expired, or the verifier does not match | Start again at Step 2 |
| 401 | `/oauth/token` | `invalid_client` | Use the client_id you registered |
| 401 | `/mcp` | `invalid_token`: the token is altered or expired | Get a new token, or call without one |
| 429 | any of the above | 20 register, authorize or token requests a minute per IP; 60 /mcp calls a minute | Back off and retry after a minute |

There is no revocation endpoint: a token expires after one hour.

## Credentials for the explorers' APIs

The explorers, BNBScan (`bnbscan.com`) and EthScan (`ethscan.io`), issue API keys through anonymous registration: no account, email or identity provider, only a wallet signature (EIP-191 `personal_sign`) that binds the key to an EVM address you control. Their chain-data endpoints are keyless too. A key gives you your own rate-limit budget instead of your IP's, and is required to manage keys and webhooks.

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
