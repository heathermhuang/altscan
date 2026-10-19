/**
 * This explorer's OAuth 2.1 server (packages/oauth). A token is another way to hold what an API key
 * gives: the X-API-Key endpoints accept `Authorization: Bearer`, counted per address. Identity is the
 * same as the keys': an EVM address proven by signature, or an existing key via client_credentials.
 *
 * Off — every OAuth path a 404, Bearer ignored — until OAUTH_SECRET is set (Render web env).
 */
import crypto from 'crypto'
import { and, eq } from 'drizzle-orm'
import { MIN_SECRET_LENGTH, type CodeGrant, type CodeStore, type OAuthConfig } from '@altscan/oauth'
import { getRedis, isRedisUnavailable } from '@altscan/explorer-core'
import { checkRateLimit, clientIpFromHeaders } from './api-rate-limit'
import { chainConfig } from './chain'
import { db, schema } from './db'

// Read and delete in one step, so a code is exchanged once even if two requests race.
const TAKE = "local v = redis.call('GET', KEYS[1]) if v then redis.call('DEL', KEYS[1]) end return v"

async function redis() {
  const r = getRedis()
  if (!r || isRedisUnavailable()) throw new Error('Redis unavailable')
  if (r.status === 'wait') await r.connect() // lazyConnect, and no offline queue to hold the first command
  return r
}

/**
 * Codes live in Redis, the one store every instance shares. There is deliberately no in-memory
 * fallback: a code must be exchangeable on any instance, and only once. Without Redis the sign-in
 * answers temporarily_unavailable.
 */
const redisCodes: CodeStore = {
  async put(code, grant, ttlSeconds) {
    await (await redis()).set(`oauth:code:${code}`, JSON.stringify(grant), 'EX', ttlSeconds)
  },
  async take(code) {
    const v = (await (await redis()).eval(TAKE, 1, `oauth:code:${code}`)) as string | null
    return v ? (JSON.parse(v) as CodeGrant) : null
  },
}

/** client_credentials: client_id is the key's prefix, client_secret the key itself. */
async function apiKeyOwner(clientId: string, clientSecret: string): Promise<string | null> {
  const keyHash = crypto.createHash('sha256').update(clientSecret).digest('hex')
  try {
    const [row] = await db
      .select({ keyPrefix: schema.apiKeys.keyPrefix, ownerAddress: schema.apiKeys.ownerAddress })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, keyHash), eq(schema.apiKeys.active, true)))
    if (!row || row.keyPrefix !== clientId || !row.ownerAddress) return null
    return row.ownerAddress.toLowerCase()
  } catch (err) {
    console.warn('[oauth] API key lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export function oauthConfig(): OAuthConfig | null {
  const secret = process.env.OAUTH_SECRET ?? ''
  if (secret.length < MIN_SECRET_LENGTH) return null
  const issuer = `https://${chainConfig.domain}`
  return {
    issuer,
    secret,
    brand: chainConfig.brandDomain,
    scope: 'api',
    scopeLabel: `the ${chainConfig.brandDomain} API`,
    chainId: chainConfig.chainId,
    codes: redisCodes,
    clientCredentials: apiKeyOwner,
    documentation: `${issuer}/auth.md`,
  }
}

/** Per IP, on the endpoints that mint a client id, a code or a token. */
const OAUTH_REQUESTS_PER_MINUTE = 20

/** A route handler that is a 404 while OAuth is off, and rate-limited where it mints something. */
export function oauthRoute(
  handler: (request: Request, cfg: OAuthConfig) => Response | Promise<Response>,
  opts: { limited?: boolean } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const cfg = oauthConfig()
    if (!cfg) return new Response('Not found', { status: 404 })
    if (opts.limited && !(await checkRateLimit(`oauth:${clientIpFromHeaders(request.headers)}`, OAUTH_REQUESTS_PER_MINUTE))) {
      return Response.json(
        { error: 'slow_down', error_description: 'Too many requests; retry in a minute.' },
        { status: 429, headers: { 'retry-after': '60', 'access-control-allow-origin': '*' } },
      )
    }
    return handler(request, cfg)
  }
}
