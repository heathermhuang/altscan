import { describe, it, expect, afterEach, vi } from 'vitest'
import { handleOAuthRequest } from '@altscan/oauth'
import { oauthConfig } from '@/lib/oauth'
import { authFailure, authRequest } from '@/lib/api-auth'
import { chainConfig } from '@/lib/chain'
import { GET as asMetadata } from '@/app/.well-known/oauth-authorization-server/route'
import { GET as prMetadata } from '@/app/.well-known/oauth-protected-resource/route'
import { POST as token } from '@/app/oauth/token/route'
import { GET as authMd } from '@/app/auth.md/route'

const SECRET = 'q'.repeat(64)
const ISSUER = `https://${chainConfig.domain}`
const OWNER = '0x' + 'ef'.repeat(20)

afterEach(() => vi.unstubAllEnvs())

/** A token as this explorer would mint it: same secret and issuer, credential lookup stubbed. */
async function mintToken(): Promise<string> {
  const cfg = { ...oauthConfig()!, clientCredentials: async () => OWNER }
  const res = await handleOAuthRequest(new Request(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=bnbs_x&client_secret=bnbs_y',
  }), cfg)
  return (await res!.json()).access_token
}

const apiRequest = (headers: Record<string, string>) =>
  new Request(`${ISSUER}/api/v1/query`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', ...headers } })

describe('OAuth is off until OAUTH_SECRET is set', () => {
  it('has no config, and every OAuth route is a 404', async () => {
    vi.stubEnv('OAUTH_SECRET', '')
    expect(oauthConfig()).toBeNull()
    vi.stubEnv('OAUTH_SECRET', 'too-short')
    expect(oauthConfig()).toBeNull()
    expect((await asMetadata(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))).status).toBe(404)
    expect((await prMetadata(new Request(`${ISSUER}/.well-known/oauth-protected-resource`))).status).toBe(404)
    expect((await token(new Request(`${ISSUER}/oauth/token`, { method: 'POST' }))).status).toBe(404)
  })

  it('ignores a Bearer header instead of refusing the request', async () => {
    vi.stubEnv('OAUTH_SECRET', '')
    expect(await authRequest(apiRequest({ authorization: 'Bearer anything' }))).toEqual({ ok: true, limited: false })
  })

  it('leaves the OAuth section out of auth.md', async () => {
    vi.stubEnv('OAUTH_SECRET', '')
    expect(await (await authMd()).text()).not.toContain('/oauth/token')
  })
})

describe('OAuth on', () => {
  it('publishes this origin as issuer and resource, with both grants', async () => {
    vi.stubEnv('OAUTH_SECRET', SECRET)
    const as = await (await asMetadata(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))).json()
    expect(as.issuer).toBe(ISSUER)
    expect(as.grant_types_supported).toEqual(['authorization_code', 'client_credentials'])
    expect(as.scopes_supported).toEqual(['api'])
    const pr = await (await prMetadata(new Request(`${ISSUER}/.well-known/oauth-protected-resource`))).json()
    expect(pr).toMatchObject({ resource: ISSUER, authorization_servers: [ISSUER], bearer_methods_supported: ['header'] })
  })

  it('accepts a valid token on the endpoints that take a key', async () => {
    vi.stubEnv('OAUTH_SECRET', SECRET)
    expect(await authRequest(apiRequest({ authorization: `Bearer ${await mintToken()}` }))).toEqual({ ok: true, limited: false })
  })

  it('refuses an altered or foreign token with a 401 that points at the metadata', async () => {
    vi.stubEnv('OAUTH_SECRET', SECRET)
    const t = await mintToken()
    vi.stubEnv('OAUTH_SECRET', 'r'.repeat(64)) // the same token under another deployment's secret
    const auth = await authRequest(apiRequest({ authorization: `Bearer ${t}` }))
    expect(auth).toEqual({ ok: false, limited: true, reason: 'invalid_token' })
    const res = authFailure(auth as Extract<typeof auth, { ok: false }>)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", error="invalid_token", error_description="The access token is invalid or expired"`,
    )
  })

  it('keeps the existing messages for keys and rate limits', async () => {
    expect(await authFailure({ ok: false, limited: true, reason: 'invalid_key' }).json()).toEqual({ error: 'Invalid or inactive API key' })
    const limited = authFailure({ ok: false, limited: true, reason: 'rate_limit' })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  it('documents both grants in auth.md', async () => {
    vi.stubEnv('OAUTH_SECRET', SECRET)
    const md = await (await authMd()).text()
    expect(md).toContain(`POST /oauth/token HTTP/1.1\nHost: ${chainConfig.domain}`)
    expect(md).toContain('grant_type=client_credentials')
    expect(md).toContain('POST /oauth/register HTTP/1.1')
    expect(md).toContain(`https://${chainConfig.domain}/.well-known/oauth-protected-resource`)
  })
})
