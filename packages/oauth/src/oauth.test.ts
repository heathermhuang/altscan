import { describe, it, expect, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import { createHash, randomBytes } from 'node:crypto'
import { redirectUriAllowed } from './checks'
import { mintAccessToken, mintClientId, readAccessToken, readClientId } from './tokens'
import {
  authorizationServerMetadata,
  handleOAuthRequest,
  protectedResourceMetadata,
  verifyBearer,
  wwwAuthenticate,
  type CodeGrant,
  type OAuthConfig,
} from './index'

const ISSUER = 'https://example.test'
const REDIRECT = 'https://client.example/callback'
const T0 = Date.parse('2026-10-20T00:00:00.000Z')

let now = T0
let cfg: OAuthConfig

function memoryCodes() {
  const m = new Map<string, CodeGrant>()
  return {
    size: () => m.size,
    async put(code: string, g: CodeGrant) { m.set(code, g) },
    async take(code: string) { const g = m.get(code) ?? null; m.delete(code); return g },
  }
}

function config(over: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    issuer: ISSUER,
    secret: 's'.repeat(40),
    brand: 'Example',
    scope: 'api',
    scopeLabel: 'the Example API',
    chainId: 56,
    codes: memoryCodes(),
    documentation: `${ISSUER}/auth.md`,
    now: () => now,
    ...over,
  }
}

beforeEach(() => {
  now = T0
  cfg = config()
})

const call = async (path: string, init: RequestInit = {}, c = cfg) => (await handleOAuthRequest(new Request(`${ISSUER}${path}`, init), c))!
const form = (o: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
})

async function register(redirectUris: unknown = [REDIRECT], extra: Record<string, unknown> = {}) {
  return call('/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: redirectUris, ...extra }) })
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st8',
    code_challenge: challenge, code_challenge_method: 'S256', ...extra,
  }).toString()
}

type Signer = { address: string; signMessage(message: string): Promise<string> }

const unescape = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))

/** What the sign-in page's script does: read the template, sign it with the wallet, post the form. */
async function signPage(html: string, wallet: Signer, tamper: (f: Record<string, string>) => void = () => {}) {
  const tpl = JSON.parse(/<script type="application\/json" id="m">(.*?)<\/script>/.exec(html)![1])
  const fields: Record<string, string> = {}
  for (const [, k, v] of html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)) fields[k] = unescape(v)
  fields.address = wallet.address
  fields.signature = await wallet.signMessage(tpl.before + wallet.address + tpl.after)
  tamper(fields)
  return call('/oauth/authorize', form(fields))
}

/** Register, open the page, sign, and return the redirect the browser would follow. */
async function signIn(wallet: Signer, tamper?: (f: Record<string, string>) => void) {
  const { client_id } = await (await register()).json()
  const p = pkce()
  const page = await call(`/oauth/authorize?${authorizeQuery(client_id, p.challenge)}`)
  expect(page.status).toBe(200)
  const res = await signPage(await page.text(), wallet, tamper)
  expect(res.status).toBe(303)
  return { clientId: client_id as string, pkce: p, location: new URL(res.headers.get('location')!) }
}

const exchange = (clientId: string, code: string, verifier: string, c = cfg) =>
  call('/oauth/token', form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT }), c)

describe('discovery', () => {
  it('describes one issuer that is also the protected resource', () => {
    const as = authorizationServerMetadata(cfg)
    expect(as.issuer).toBe(ISSUER)
    expect(as.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`)
    expect(as.token_endpoint).toBe(`${ISSUER}/oauth/token`)
    expect(as.registration_endpoint).toBe(`${ISSUER}/oauth/register`)
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
    expect(as.grant_types_supported).toEqual(['authorization_code'])
    const pr = protectedResourceMetadata(cfg)
    expect(pr.resource).toBe(ISSUER)
    expect(pr.authorization_servers).toEqual([ISSUER])
    expect(pr.bearer_methods_supported).toEqual(['header'])
  })

  it('advertises client_credentials only where a credential lookup exists', () => {
    const c = config({ clientCredentials: async () => null })
    expect(authorizationServerMetadata(c).grant_types_supported).toEqual(['authorization_code', 'client_credentials'])
  })

  it('serves both documents with CORS', async () => {
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']) {
      const res = await call(p)
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    }
  })
})

describe('registration', () => {
  it('registers a public client and answers with what it registered', async () => {
    const res = await register([REDIRECT], { client_name: 'Agent\n<b>X</b>', grant_types: ['authorization_code', 'refresh_token'] })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.client_id).toMatch(/^ac1\./)
    expect(body.client_name).toBe('Agent <b>X</b>')
    expect(body.grant_types).toEqual(['authorization_code'])
    expect(body.token_endpoint_auth_method).toBe('none')
  })

  it.each([
    [['http://client.example/cb']],
    [['javascript:alert(1)']],
    [['https://client.example/cb#frag']],
    [['https://user:pw@client.example/cb']],
    [[]],
    [Array(5).fill(REDIRECT)],
    ['https://client.example/cb'],
  ])('refuses redirect_uris %j', async (uris) => {
    expect((await register(uris)).status).toBe(400)
  })

  it('accepts loopback http and private-use schemes', async () => {
    expect((await register(['http://127.0.0.1:33418/cb', 'http://localhost/cb', 'cursor://anysphere/oauth'])).status).toBe(201)
  })

  it('refuses schemes that launch an OS protocol handler or another program', async () => {
    for (const uri of [
      'ms-msdt:/id PCWDiagnostic /skip force /param "IT_RebrowseForFile=?"',
      'ms-excel:ofe|u|https://client.example/x.xlsx',
      'MS-Word:ofe|u|https://client.example/x.docx',
      'search-ms:query=x&crumb=location:\\\\client.example\\share',
      'search:query=x',
      'smb://client.example/share',
      'ssh://client.example',
      'telnet://client.example',
      'mailto:a@client.example',
      'tel:+15551234567',
      'sms:+15551234567',
      'intent://scan/#Intent;scheme=zxing;end',
      'view-source:https://client.example/',
      'chrome://settings',
      'chrome-extension://abcdefgh/cb',
      'chrome-untrusted://x/',
      'moz-extension://abcdefgh/cb',
      'moz-icon://x',
    ]) {
      expect(redirectUriAllowed(uri), uri).toBe(false)
    }
    expect((await register(['ms-msdt:/id PCWDiagnostic'])).status).toBe(400)
    expect((await register([REDIRECT, 'search-ms:query=x'])).status).toBe(400)
  })

  it('still accepts https, loopback http and native-app private-use schemes', () => {
    for (const uri of [
      REDIRECT,
      'http://127.0.0.1:33418/cb',
      'http://localhost/cb',
      'http://[::1]:8080/cb',
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'vscode://vscode.github-authentication/did-authenticate',
      'com.example.app:/oauth2redirect',
    ]) {
      expect(redirectUriAllowed(uri), uri).toBe(true)
    }
  })

  it('refuses confidential clients', async () => {
    expect((await register([REDIRECT], { token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400)
  })
})

describe('authorization endpoint', () => {
  it('shows an error, never redirects, for an unknown or altered client_id', async () => {
    const { client_id } = await (await register()).json()
    const altered = client_id.slice(0, -2) + (client_id.endsWith('A') ? 'BB' : 'AA')
    for (const id of ['nope', altered]) {
      const res = await call(`/oauth/authorize?${authorizeQuery(id, pkce().challenge)}`)
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
    }
  })

  it('shows an error, never redirects, for a redirect_uri the client did not register', async () => {
    const { client_id } = await (await register()).json()
    const res = await call(`/oauth/authorize?${authorizeQuery(client_id, pkce().challenge, { redirect_uri: 'https://evil.example/cb' })}`)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('shows an error, never redirects, for a client id registered before a scheme was blocked', async () => {
    // A client id carries its own registration and never expires, so ones minted under the old rules still verify.
    const legacy = await mintClientId(cfg.secret, { redirect_uris: ['search-ms:query=x'], client_name: null, iat: T0 / 1000 })
    for (const extra of [{}, { response_type: 'token' }, { code_challenge_method: 'plain' }] as Array<Record<string, string>>) {
      const res = await call(`/oauth/authorize?${authorizeQuery(legacy, pkce().challenge, { redirect_uri: 'search-ms:query=x', ...extra })}`)
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
    }
  })

  it('sends protocol errors back to the client: missing PKCE, other scopes, other resources', async () => {
    const { client_id } = await (await register()).json()
    const cases: Array<[Record<string, string>, string]> = [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ scope: 'admin' }, 'invalid_scope'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ]
    for (const [extra, error] of cases) {
      const res = await call(`/oauth/authorize?${authorizeQuery(client_id, pkce().challenge, extra)}`)
      expect(res.status).toBe(303)
      const loc = new URL(res.headers.get('location')!)
      expect(loc.origin + loc.pathname).toBe(REDIRECT)
      expect(loc.searchParams.get('error')).toBe(error)
      expect(loc.searchParams.get('state')).toBe('st8')
      expect(loc.searchParams.get('iss')).toBe(ISSUER)
    }
  })

  it('accepts a resource on its own origin (an MCP client names the endpoint)', async () => {
    const { client_id } = await (await register()).json()
    expect((await call(`/oauth/authorize?${authorizeQuery(client_id, pkce().challenge, { resource: `${ISSUER}/mcp` })}`)).status).toBe(200)
  })

  it('renders a page that lets the form reach only itself and the client', async () => {
    const { client_id } = await (await register()).json()
    const res = await call(`/oauth/authorize?${authorizeQuery(client_id, pkce().challenge)}`)
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("form-action 'self' https://client.example;")
    expect(csp).toContain("script-src 'self';")
    expect(csp).toContain("frame-ancestors 'none'")
  })
})

describe('sign-in to token', () => {
  it('turns a wallet signature into a one-hour token for that address', async () => {
    const wallet = Wallet.createRandom()
    const { clientId, pkce: p, location } = await signIn(wallet)
    expect(location.searchParams.get('state')).toBe('st8')
    expect(location.searchParams.get('iss')).toBe(ISSUER)
    const res = await exchange(clientId, location.searchParams.get('code')!, p.verifier)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const tok = await res.json()
    expect(tok).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'api' })
    expect(await verifyBearer(`Bearer ${tok.access_token}`, cfg)).toEqual({ sub: wallet.address.toLowerCase(), clientId })
    now += 3601_000
    expect(await verifyBearer(`Bearer ${tok.access_token}`, cfg)).toBe('invalid')
  })

  it('spends a code once, even when the first try had the wrong verifier', async () => {
    const { clientId, pkce: p, location } = await signIn(Wallet.createRandom())
    const code = location.searchParams.get('code')!
    expect((await exchange(clientId, code, pkce().verifier)).status).toBe(400)
    const again = await exchange(clientId, code, p.verifier)
    expect(again.status).toBe(400)
    expect((await again.json()).error).toBe('invalid_grant')
  })

  it('refuses a code minted under another issuer, even on a shared store and secret', async () => {
    const shared = memoryCodes()
    const A = config({ codes: shared })
    const B = config({ codes: shared, issuer: 'https://other.example' })
    cfg = A
    const { clientId, pkce: p, location } = await signIn(Wallet.createRandom())
    const code = location.searchParams.get('code')!
    const res = await exchange(clientId, code, p.verifier, B)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
    // The refusal still spends the code: it is not left for a retry on the issuer that minted it.
    expect((await exchange(clientId, code, p.verifier, A)).status).toBe(400)

    const again = await signIn(Wallet.createRandom())
    const ok = await exchange(again.clientId, again.location.searchParams.get('code')!, again.pkce.verifier, config({ codes: shared }))
    expect(ok.status).toBe(200)
  })

  it('refuses a stored grant that carries no issuer', async () => {
    const { client_id } = await (await register()).json()
    const p = pkce()
    await cfg.codes.put('legacy-code', {
      client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, scope: 'api', sub: '0x' + 'ab'.repeat(20),
    } as CodeGrant, 60)
    const res = await exchange(client_id, 'legacy-code', p.verifier)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('refuses a code for another client', async () => {
    const { pkce: p, location } = await signIn(Wallet.createRandom())
    const { client_id: other } = await (await register()).json()
    expect((await exchange(other, location.searchParams.get('code')!, p.verifier)).status).toBe(400)
  })

  it('denies a signature from another wallet, or over another request', async () => {
    const wallet = Wallet.createRandom()
    const otherSig = await Wallet.createRandom().signMessage('x')
    for (const tamper of [
      (f: Record<string, string>) => { f.signature = otherSig },
      (f: Record<string, string>) => { f.address = Wallet.createRandom().address },
      (f: Record<string, string>) => { f.code_challenge = pkce().challenge },
      (f: Record<string, string>) => { f.nonce = 'differentnonce' },
    ]) {
      const { location } = await signIn(wallet, tamper)
      expect(location.searchParams.get('error')).toBe('access_denied')
      expect(location.searchParams.get('code')).toBeNull()
    }
  })

  it('denies a signature older than the sign-in window', async () => {
    const { client_id } = await (await register()).json()
    const page = await (await call(`/oauth/authorize?${authorizeQuery(client_id, pkce().challenge)}`)).text()
    now += 11 * 60_000
    const res = await signPage(page, Wallet.createRandom())
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
  })

  it('reports a failed code store to the client instead of issuing a code', async () => {
    cfg = config({ codes: { put: async () => { throw new Error('down') }, take: async () => null } })
    const { location } = await signIn(Wallet.createRandom())
    expect(location.searchParams.get('error')).toBe('temporarily_unavailable')
  })
})

describe('client_credentials', () => {
  const OWNER = '0x' + 'ab'.repeat(20)
  const withKeys = () => config({ clientCredentials: async (id, secret) => (id === 'kid' && secret === 'ksecret' ? OWNER : null) })
  const cc = (body: Record<string, string>, headers: Record<string, string> = {}, c = cfg) =>
    call('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() }, c)

  it('exchanges a credential, in the body or as Basic, for a token for its owner', async () => {
    const c = withKeys()
    for (const res of [
      await cc({ grant_type: 'client_credentials', client_id: 'kid', client_secret: 'ksecret' }, {}, c),
      await cc({ grant_type: 'client_credentials' }, { authorization: `Basic ${btoa('kid:ksecret')}` }, c),
    ]) {
      expect(res.status).toBe(200)
      expect(await verifyBearer(`Bearer ${(await res.json()).access_token}`, c)).toEqual({ sub: OWNER, clientId: 'kid' })
    }
  })

  it('refuses a wrong secret, and two authentication methods at once', async () => {
    const c = withKeys()
    const wrong = await cc({ grant_type: 'client_credentials', client_id: 'kid', client_secret: 'nope' }, {}, c)
    expect(wrong.status).toBe(401)
    expect((await wrong.json()).error).toBe('invalid_client')
    const both = await cc({ grant_type: 'client_credentials', client_id: 'kid', client_secret: 'ksecret' }, { authorization: `Basic ${btoa('kid:ksecret')}` }, c)
    expect((await both.json()).error).toBe('invalid_request')
  })

  it('is not a grant where no credential lookup exists', async () => {
    const res = await cc({ grant_type: 'client_credentials', client_id: 'kid', client_secret: 'ksecret' })
    expect((await res.json()).error).toBe('unsupported_grant_type')
  })
})

describe('bearer verification', () => {
  async function token(c = cfg) {
    const { clientId, pkce: p, location } = await signIn(Wallet.createRandom())
    return (await (await exchange(clientId, location.searchParams.get('code')!, p.verifier, c)).json()).access_token as string
  }

  it('ignores other schemes and refuses altered or foreign tokens', async () => {
    const t = await token()
    expect(await verifyBearer(null, cfg)).toBeNull()
    expect(await verifyBearer('Basic abc', cfg)).toBeNull()
    expect(await verifyBearer('Bearer', cfg)).toBe('invalid')
    const [h, body, sig] = t.split('.')
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString())
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: '0x' + '00'.repeat(20) })).toString('base64url')}.${sig}`
    expect(await verifyBearer(`Bearer ${forged}`, cfg)).toBe('invalid')
    expect(await verifyBearer(`Bearer ${t}`, config({ secret: 't'.repeat(40) }))).toBe('invalid')
    expect(await verifyBearer(`Bearer ${t}`, config({ issuer: 'https://other.example' }))).toBe('invalid')
    expect(await verifyBearer(`Bearer ${t}`, config({ scope: 'mcp' }))).toBe('invalid')
  })

  it('accepts one spelling of a signature: the canonical base64url, not its trailing-bit siblings', async () => {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    // A 32-byte HMAC is 43 characters whose last one carries 4 bits and 2 padding bits that decoders ignore.
    const sibling = (signed: string) => signed.slice(0, -1) + ALPHABET[ALPHABET.indexOf(signed.at(-1)!) ^ 1]
    const nowSeconds = T0 / 1000
    const expected = { issuer: ISSUER, scope: 'api', nowSeconds }

    const token = await mintAccessToken(cfg.secret, {
      iss: ISSUER, aud: ISSUER, sub: '0x' + 'ab'.repeat(20), client_id: 'ac1.x', scope: 'api', iat: nowSeconds, exp: nowSeconds + 3600, jti: 'j',
    })
    const otherToken = sibling(token)
    expect(otherToken).not.toBe(token)
    // Same bytes, so a lenient decoder would call it the same signature.
    expect(Buffer.from(otherToken.split('.')[2], 'base64url').equals(Buffer.from(token.split('.')[2], 'base64url'))).toBe(true)
    expect((await readAccessToken(cfg.secret, token, expected))?.client_id).toBe('ac1.x')
    expect(await readAccessToken(cfg.secret, otherToken, expected)).toBeNull()
    expect(await verifyBearer(`Bearer ${otherToken}`, cfg)).toBe('invalid')

    const clientId = await mintClientId(cfg.secret, { redirect_uris: [REDIRECT], client_name: null, iat: nowSeconds })
    const otherClientId = sibling(clientId)
    expect(otherClientId).not.toBe(clientId)
    expect(await readClientId(cfg.secret, clientId)).not.toBeNull()
    expect(await readClientId(cfg.secret, otherClientId)).toBeNull()
  })

  it('points a 401 at the protected-resource metadata', () => {
    expect(wwwAuthenticate(cfg)).toBe(`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`)
    expect(wwwAuthenticate(cfg, true)).toContain('error="invalid_token"')
  })
})
