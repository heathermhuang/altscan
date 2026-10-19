import { b64url, b64urlDecode, hmacSign, hmacVerify, randomToken, utf8 } from './crypto'

const dec = new TextDecoder()
const MAX_TOKEN_LENGTH = 4096
const ADDRESS = /^0x[0-9a-f]{40}$/

function decodeJson(part: string): unknown {
  const bytes = b64urlDecode(part)
  if (!bytes) return null
  try {
    return JSON.parse(dec.decode(bytes))
  } catch {
    return null
  }
}

// ── Access tokens ─────────────────────────────────────────────────────────────
// RFC 9068-shaped JWTs, HS256 with a key only the issuing origin holds: each origin verifies its own
// tokens, so nothing needs a published key (no jwks_uri).

export interface AccessClaims {
  iss: string
  aud: string
  /** The lowercase EVM address the holder proved control of. */
  sub: string
  client_id: string
  scope: string
  iat: number
  exp: number
  jti: string
}

const HEADER = b64url(utf8(JSON.stringify({ alg: 'HS256', typ: 'at+jwt' })))

export async function mintAccessToken(secret: string, claims: AccessClaims): Promise<string> {
  const body = `${HEADER}.${b64url(utf8(JSON.stringify(claims)))}`
  return `${body}.${await hmacSign(secret, 'access-token', body)}`
}

/** The claims of a token this issuer minted for this scope that has not expired, or null. */
export async function readAccessToken(
  secret: string,
  token: string,
  expect: { issuer: string; scope: string; nowSeconds: number },
): Promise<AccessClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== HEADER) return null
  if (!(await hmacVerify(secret, 'access-token', `${parts[0]}.${parts[1]}`, parts[2]))) return null
  const c = decodeJson(parts[1]) as Partial<AccessClaims> | null
  if (!c || typeof c !== 'object') return null
  if (c.iss !== expect.issuer || c.aud !== expect.issuer) return null
  if (typeof c.exp !== 'number' || c.exp <= expect.nowSeconds) return null
  if (typeof c.iat !== 'number' || c.iat > expect.nowSeconds + 60) return null
  if (typeof c.sub !== 'string' || !ADDRESS.test(c.sub)) return null
  if (typeof c.client_id !== 'string' || typeof c.jti !== 'string') return null
  if (typeof c.scope !== 'string' || !c.scope.split(' ').includes(expect.scope)) return null
  return c as AccessClaims
}

// ── Client IDs ────────────────────────────────────────────────────────────────
// Dynamic registration (RFC 7591) without storage: the client_id carries its own registration,
// signed, so the authorize and token endpoints can check redirect URIs from the id alone.

export interface ClientRecord {
  redirect_uris: string[]
  client_name: string | null
  iat: number
}

const CLIENT_PREFIX = 'ac1.'

export async function mintClientId(secret: string, rec: ClientRecord): Promise<string> {
  // The random part keeps two identical registrations in the same second from sharing an id.
  const body = b64url(utf8(JSON.stringify([rec.redirect_uris, rec.client_name, rec.iat, randomToken(9)])))
  return `${CLIENT_PREFIX}${body}.${await hmacSign(secret, 'client-id', body)}`
}

export async function readClientId(secret: string, clientId: string): Promise<ClientRecord | null> {
  if (clientId.length > MAX_TOKEN_LENGTH || !clientId.startsWith(CLIENT_PREFIX)) return null
  const parts = clientId.slice(CLIENT_PREFIX.length).split('.')
  if (parts.length !== 2) return null
  if (!(await hmacVerify(secret, 'client-id', parts[0], parts[1]))) return null
  const v = decodeJson(parts[0])
  if (!Array.isArray(v) || v.length !== 4) return null
  const [uris, name, iat] = v as [unknown, unknown, unknown, unknown]
  if (!Array.isArray(uris) || !uris.every((u) => typeof u === 'string')) return null
  if (name !== null && typeof name !== 'string') return null
  if (typeof iat !== 'number') return null
  return { redirect_uris: uris as string[], client_name: name as string | null, iat }
}
