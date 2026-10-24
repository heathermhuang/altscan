// An OAuth 2.1 authorization server whose only identity is an EVM address the user or agent proves
// by signing (EIP-191). Fetch-API handlers, so the explorers (Next route handlers) and altscan.io (a
// Worker) serve the same protocol. Each origin is its own issuer and the only verifier of its tokens.
import {
  CODE_CHALLENGE,
  MAX_REDIRECT_URIS,
  cleanClientName,
  pkceMatches,
  redirectTarget,
  redirectUriAllowed,
  requestIdFor,
  signInMessage,
  signerOf,
} from './checks'
import { randomToken } from './crypto'
import { mintAccessToken, mintClientId, readAccessToken, readClientId, type ClientRecord } from './tokens'

export interface CodeGrant {
  /** The issuer that minted the code. The exchange refuses a code from another one, even on a shared store and secret. */
  iss: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  scope: string
  sub: string
}

/** Authorization codes are single-use (OAuth 2.1 §4.1.3): `take` must read and delete atomically. */
export interface CodeStore {
  put(code: string, grant: CodeGrant, ttlSeconds: number): Promise<void>
  take(code: string): Promise<CodeGrant | null>
}

export interface OAuthConfig {
  /** This origin, e.g. https://bnbscan.com: issuer, token audience and protected resource at once. */
  issuer: string
  /** HMAC root for tokens and client ids. At least MIN_SECRET_LENGTH characters. */
  secret: string
  brand: string
  scope: string
  /** What a token grants, as the sign-in message says it: "the BNBScan API". */
  scopeLabel: string
  chainId: number
  codes: CodeStore
  /** client_credentials, for clients that already hold a credential here: id + secret → owner address. */
  clientCredentials?: (clientId: string, clientSecret: string) => Promise<string | null>
  /** The auth.md that explains all of this to an agent. */
  documentation: string
  /** Milliseconds; tests pin it. */
  now?: () => number
}

export const MIN_SECRET_LENGTH = 32
export const ACCESS_TOKEN_TTL_S = 3600
const CODE_TTL_S = 60
/** A signature is accepted this long after the page stamped its Issued At. */
const SIGN_IN_WINDOW_S = 600
const MAX_BODY_BYTES = 16 * 1024

export const OAUTH_PATHS = {
  asMetadata: '/.well-known/oauth-authorization-server',
  prMetadata: '/.well-known/oauth-protected-resource',
  register: '/oauth/register',
  authorize: '/oauth/authorize',
  authorizeScript: '/oauth/authorize.js',
  token: '/oauth/token',
} as const

const nowMs = (cfg: OAuthConfig) => (cfg.now ? cfg.now() : Date.now())

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...headers },
  })
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } })
}

// ── Discovery ─────────────────────────────────────────────────────────────────

export function authorizationServerMetadata(cfg: OAuthConfig) {
  const at = (p: string) => `${cfg.issuer}${p}`
  return {
    issuer: cfg.issuer,
    authorization_endpoint: at(OAUTH_PATHS.authorize),
    token_endpoint: at(OAUTH_PATHS.token),
    registration_endpoint: at(OAUTH_PATHS.register),
    scopes_supported: [cfg.scope],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: cfg.clientCredentials ? ['authorization_code', 'client_credentials'] : ['authorization_code'],
    token_endpoint_auth_methods_supported: cfg.clientCredentials ? ['none', 'client_secret_basic', 'client_secret_post'] : ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: cfg.documentation,
  }
}

export function protectedResourceMetadata(cfg: OAuthConfig) {
  return {
    resource: cfg.issuer,
    authorization_servers: [cfg.issuer],
    scopes_supported: [cfg.scope],
    bearer_methods_supported: ['header'],
    resource_name: cfg.brand,
    resource_documentation: cfg.documentation,
  }
}

export function metadataResponse(body: unknown): Response {
  return json(body, 200, { 'cache-control': 'public, max-age=3600' })
}

// ── Dynamic client registration (RFC 7591), public clients only ───────────────

export async function handleRegister(req: Request, cfg: OAuthConfig): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ error: 'invalid_request', error_description: 'Use POST.' }, 405)
  const meta = await readJson(req)
  const bad = (d: string) => json({ error: 'invalid_client_metadata', error_description: d }, 400)
  if (!meta) return bad('The body must be a JSON object.')
  const uris = meta.redirect_uris
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS) {
    return json({ error: 'invalid_redirect_uri', error_description: `Send 1-${MAX_REDIRECT_URIS} redirect_uris.` }, 400)
  }
  if (!uris.every((u) => typeof u === 'string' && redirectUriAllowed(u))) {
    return json({ error: 'invalid_redirect_uri', error_description: 'Each redirect URI must be https, http on loopback, or a private-use scheme, with no fragment.' }, 400)
  }
  const method = meta.token_endpoint_auth_method
  if (method !== undefined && method !== 'none') {
    return bad(cfg.clientCredentials
      ? 'Only public clients (token_endpoint_auth_method "none") register here. For client_credentials, use an API key as the client secret; see ' + cfg.documentation
      : 'Only public clients (token_endpoint_auth_method "none") register here.')
  }
  const rec: ClientRecord = {
    redirect_uris: uris as string[],
    client_name: cleanClientName(meta.client_name),
    iat: Math.floor(nowMs(cfg) / 1000),
  }
  // RFC 7591 §3.2.1: the server answers with the metadata it actually registered, which may differ
  // from the request (e.g. a refresh_token grant asked for and not supported).
  return json({
    client_id: await mintClientId(cfg.secret, rec),
    client_id_issued_at: rec.iat,
    ...(rec.client_name ? { client_name: rec.client_name } : {}),
    redirect_uris: rec.redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: cfg.scope,
  }, 201)
}

// ── Authorization endpoint ────────────────────────────────────────────────────

interface AuthzRequest {
  client: ClientRecord
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  scope: string
}

type Checked = { ok: AuthzRequest } | { fail: Response }

/**
 * RFC 6749 §4.1.2.1: until client_id and redirect_uri check out, errors are shown here and never
 * redirected (an open redirector otherwise). After that, errors go back to the client.
 */
async function checkAuthorize(p: URLSearchParams, cfg: OAuthConfig): Promise<Checked> {
  const clientId = p.get('client_id') ?? ''
  const client = await readClientId(cfg.secret, clientId)
  if (!client) return { fail: errorPage(400, 'This app is not registered here (unknown or altered client_id).', cfg) }
  const asked = p.get('redirect_uri')
  const redirectUri = asked ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null)
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { fail: errorPage(400, 'The redirect_uri is not one this app registered.', cfg) }
  }
  const state = p.get('state')
  const back = (error: string, description: string) => ({ fail: redirectBack(redirectUri, { error, error_description: description }, state, cfg) })
  if (state !== null && state.length > 1024) return back('invalid_request', 'state is longer than 1024 characters.')
  if (p.get('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.')
  const codeChallenge = p.get('code_challenge') ?? ''
  if (p.get('code_challenge_method') !== 'S256' || !CODE_CHALLENGE.test(codeChallenge)) {
    return back('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.')
  }
  const scopes = (p.get('scope') ?? cfg.scope).split(' ').filter(Boolean)
  if (scopes.length === 0 || scopes.some((s) => s !== cfg.scope)) return back('invalid_scope', `The only scope is "${cfg.scope}".`)
  const resource = p.get('resource')
  if (resource !== null && !sameOrigin(resource, cfg.issuer)) {
    return back('invalid_target', `Tokens from this server are for ${cfg.issuer} only.`)
  }
  return { ok: { client, clientId, redirectUri, state, codeChallenge, scope: cfg.scope } }
}

export async function handleAuthorize(req: Request, cfg: OAuthConfig): Promise<Response> {
  if (req.method === 'GET') {
    const checked = await checkAuthorize(new URL(req.url).searchParams, cfg)
    if ('fail' in checked) return checked.fail
    return signInPage(checked.ok, new URL(req.url).searchParams, cfg)
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const form = await readForm(req)
  if (!form) return errorPage(400, 'Send the sign-in form as application/x-www-form-urlencoded.', cfg)
  const checked = await checkAuthorize(form, cfg)
  if ('fail' in checked) return checked.fail
  const a = checked.ok
  const deny = (d: string) => redirectBack(a.redirectUri, { error: 'access_denied', error_description: d }, a.state, cfg)

  const address = form.get('address') ?? ''
  const signature = form.get('signature') ?? ''
  const nonce = form.get('nonce') ?? ''
  const issuedAt = form.get('issued_at') ?? ''
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return deny('Missing or malformed address or signature.')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return deny('Missing or malformed nonce.')
  const issuedMs = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(issuedAt) ? Date.parse(issuedAt) : NaN
  const now = nowMs(cfg)
  if (!Number.isFinite(issuedMs) || issuedMs > now + 60_000 || issuedMs < now - SIGN_IN_WINDOW_S * 1000) {
    return deny(`Issued At must be within the last ${SIGN_IN_WINDOW_S / 60} minutes; sign again.`)
  }
  const m = signInMessage(await signInFields(a, cfg, nonce, issuedAt))
  if (signerOf(m.before + address + m.after, signature) !== address.toLowerCase()) {
    return deny('The signature does not match the address and this request.')
  }
  const code = randomToken(32)
  try {
    await cfg.codes.put(code, {
      iss: cfg.issuer, client_id: a.clientId, redirect_uri: a.redirectUri, code_challenge: a.codeChallenge, scope: a.scope, sub: address.toLowerCase(),
    }, CODE_TTL_S)
  } catch {
    return redirectBack(a.redirectUri, { error: 'temporarily_unavailable', error_description: 'Could not store the authorization code; try again.' }, a.state, cfg)
  }
  return redirectBack(a.redirectUri, { code }, a.state, cfg)
}

async function signInFields(a: AuthzRequest, cfg: OAuthConfig, nonce: string, issuedAt: string) {
  return {
    host: new URL(cfg.issuer).host,
    issuer: cfg.issuer,
    scopeLabel: cfg.scopeLabel,
    chainId: cfg.chainId,
    clientName: a.client.client_name,
    redirectUri: a.redirectUri,
    nonce,
    issuedAt,
    requestId: await requestIdFor(a.clientId, a.redirectUri, a.codeChallenge, a.scope),
  }
}

function redirectBack(redirectUri: string, params: Record<string, string>, state: string | null, cfg: OAuthConfig): Response {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  if (state !== null) u.searchParams.set('state', state)
  u.searchParams.set('iss', cfg.issuer) // RFC 9207
  return new Response(null, { status: 303, headers: { location: u.toString(), 'cache-control': 'no-store' } })
}

// ── Token endpoint ────────────────────────────────────────────────────────────

export async function handleToken(req: Request, cfg: OAuthConfig): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return tokenError(405, 'invalid_request', 'Use POST.')
  const p = await readForm(req)
  if (!p) return tokenError(400, 'invalid_request', 'Send application/x-www-form-urlencoded.')
  const grant = p.get('grant_type')
  if (grant === 'authorization_code') return codeGrant(p, cfg)
  if (grant === 'client_credentials' && cfg.clientCredentials) return clientCredentialsGrant(req, p, cfg)
  return tokenError(400, 'unsupported_grant_type', `Supported: ${authorizationServerMetadata(cfg).grant_types_supported.join(', ')}.`)
}

async function codeGrant(p: URLSearchParams, cfg: OAuthConfig): Promise<Response> {
  const code = p.get('code') ?? ''
  const clientId = p.get('client_id') ?? ''
  if (!code || code.length > 128) return tokenError(400, 'invalid_request', 'Missing code.')
  if (!(await readClientId(cfg.secret, clientId))) return tokenError(401, 'invalid_client', 'Unknown client_id.')
  // Taken before anything else is checked, so a code presented with a wrong verifier is spent too.
  let g: CodeGrant | null
  try {
    g = await cfg.codes.take(code)
  } catch {
    return tokenError(503, 'temporarily_unavailable', 'Try again.')
  }
  // A grant without `iss` (stored before codes carried one) is a mismatch, not a pass.
  if (!g || g.iss !== cfg.issuer || g.client_id !== clientId) return tokenError(400, 'invalid_grant', 'The code is unknown, used, expired, or for another client or issuer.')
  const redirectUri = p.get('redirect_uri')
  if (redirectUri !== null && redirectUri !== g.redirect_uri) return tokenError(400, 'invalid_grant', 'redirect_uri does not match.')
  if (!(await pkceMatches(p.get('code_verifier') ?? '', g.code_challenge))) return tokenError(400, 'invalid_grant', 'code_verifier does not match code_challenge.')
  return issue(cfg, g.sub, clientId, g.scope)
}

async function clientCredentialsGrant(req: Request, p: URLSearchParams, cfg: OAuthConfig): Promise<Response> {
  const basic = parseBasic(req.headers.get('authorization'))
  const bodyId = p.get('client_id')
  const bodySecret = p.get('client_secret')
  if (basic && (bodyId !== null || bodySecret !== null)) return tokenError(400, 'invalid_request', 'Authenticate with one method, not two.')
  const id = basic?.id ?? bodyId ?? ''
  const secret = basic?.secret ?? bodySecret ?? ''
  const scopes = (p.get('scope') ?? cfg.scope).split(' ').filter(Boolean)
  if (scopes.some((s) => s !== cfg.scope)) return tokenError(400, 'invalid_scope', `The only scope is "${cfg.scope}".`)
  const sub = id && secret ? await cfg.clientCredentials!(id, secret) : null
  if (!sub) return tokenError(401, 'invalid_client', 'Unknown or inactive client credentials.', { 'www-authenticate': 'Basic realm="token"' })
  return issue(cfg, sub.toLowerCase(), id, cfg.scope)
}

async function issue(cfg: OAuthConfig, sub: string, clientId: string, scope: string): Promise<Response> {
  const iat = Math.floor(nowMs(cfg) / 1000)
  const accessToken = await mintAccessToken(cfg.secret, {
    iss: cfg.issuer, aud: cfg.issuer, sub, client_id: clientId, scope, iat, exp: iat + ACCESS_TOKEN_TTL_S, jti: randomToken(16),
  })
  return json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, scope }, 200, { pragma: 'no-cache' })
}

function tokenError(status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
  return json({ error, error_description: description }, status, headers)
}

function parseBasic(header: string | null): { id: string; secret: string } | null {
  const m = header ? /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(header.trim()) : null
  if (!m) return null
  try {
    const raw = atob(m[1])
    const i = raw.indexOf(':')
    if (i < 0) return null
    // RFC 6749 §2.3.1: both parts are form-urlencoded before encoding.
    return { id: decodeURIComponent(raw.slice(0, i).replace(/\+/g, ' ')), secret: decodeURIComponent(raw.slice(i + 1).replace(/\+/g, ' ')) }
  } catch {
    return null
  }
}

// ── Resource server side ──────────────────────────────────────────────────────

/**
 * null: no bearer credential (other Authorization schemes are not ours to judge).
 * 'invalid': a bearer token this origin does not accept; answer 401 with wwwAuthenticate(cfg, true).
 */
export async function verifyBearer(header: string | null, cfg: OAuthConfig): Promise<{ sub: string; clientId: string } | 'invalid' | null> {
  if (!header || !/^bearer\b/i.test(header.trim())) return null
  const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim())
  if (!m) return 'invalid'
  const c = await readAccessToken(cfg.secret, m[1], { issuer: cfg.issuer, scope: cfg.scope, nowSeconds: Math.floor(nowMs(cfg) / 1000) })
  return c ? { sub: c.sub, clientId: c.client_id } : 'invalid'
}

/** RFC 9728 §5.1: point a client that got a 401 at the metadata that says how to get a token. */
export function wwwAuthenticate(cfg: OAuthConfig, invalidToken = false): string {
  const base = `Bearer resource_metadata="${cfg.issuer}${OAUTH_PATHS.prMetadata}"`
  return invalidToken ? `${base}, error="invalid_token", error_description="The access token is invalid or expired"` : base
}

// ── One dispatcher, for hosts that route by path themselves (the Worker) ──────

export async function handleOAuthRequest(req: Request, cfg: OAuthConfig): Promise<Response | null> {
  switch (new URL(req.url).pathname) {
    case OAUTH_PATHS.asMetadata:
      return req.method === 'OPTIONS' ? preflight() : metadataResponse(authorizationServerMetadata(cfg))
    case OAUTH_PATHS.prMetadata:
      return req.method === 'OPTIONS' ? preflight() : metadataResponse(protectedResourceMetadata(cfg))
    case OAUTH_PATHS.register:
      return handleRegister(req, cfg)
    case OAUTH_PATHS.authorize:
      return handleAuthorize(req, cfg)
    case OAUTH_PATHS.authorizeScript:
      return authorizeScript()
    case OAUTH_PATHS.token:
      return handleToken(req, cfg)
    default:
      return null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return null
  const text = await req.text()
  return text.length > MAX_BODY_BYTES ? null : text
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return null
  const text = await readBody(req)
  return text === null ? null : new URLSearchParams(text)
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await readBody(req)
  if (text === null) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const PAGE_STYLE =
  'body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#fbfbfc;color:#16161d}' +
  'main{max-width:34rem;margin:0 auto;padding:48px 16px}h1{font-size:1.5rem;margin:0 0 16px}' +
  'code{font:14px ui-monospace,monospace;word-break:break-all}.note{color:#5b5b66;font-size:14px}a{color:inherit}' +
  'button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#16161d;color:#fff;cursor:pointer}' +
  'button:disabled{opacity:.5}@media(prefers-color-scheme:dark){body{background:#0b0b0f;color:#ececf1}' +
  '.note{color:#a0a0ab}button{background:#ececf1;color:#0b0b0f}}'

function page(title: string, body: string, extraHeaders: Record<string, string>, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  })
}

function errorPage(status: number, message: string, cfg: OAuthConfig): Response {
  return page(`Sign-in error · ${cfg.brand}`, `<h1>Can't sign in</h1><p>${esc(message)}</p><p class="note">Agents: see <a href="${esc(cfg.documentation)}">auth.md</a>.</p>`, {
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  }, status)
}

async function signInPage(a: AuthzRequest, p: URLSearchParams, cfg: OAuthConfig): Promise<Response> {
  const nonce = randomToken(16)
  const issuedAt = new Date(nowMs(cfg)).toISOString()
  const message = signInMessage(await signInFields(a, cfg, nonce, issuedAt))
  const hidden: Record<string, string> = {
    response_type: 'code',
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    code_challenge: a.codeChallenge,
    code_challenge_method: 'S256',
    scope: a.scope,
    nonce,
    issued_at: issuedAt,
    address: '',
    signature: '',
  }
  if (a.state !== null) hidden.state = a.state
  const resource = p.get('resource')
  if (resource !== null) hidden.resource = resource
  const inputs = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')
  const who = a.client.client_name ? `<strong>${esc(a.client.client_name)}</strong> (a name the app chose itself)` : 'An app that gave no name'
  const target = redirectTarget(a.redirectUri)
  const body =
    `<h1>Sign in to ${esc(cfg.brand)}</h1>` +
    `<p>${who} wants to use ${esc(cfg.scopeLabel)} as your address.</p>` +
    `<p>After you sign, you go back to <code>${esc(target)}</code>.</p>` +
    `<p class="note">Signing proves you control the address. It is not a transaction and costs nothing. The app gets a token for ${esc(cfg.scopeLabel)} that lasts one hour; it cannot move funds or act as you anywhere else.</p>` +
    `<form id="f" method="post" action="${OAUTH_PATHS.authorize}">${inputs}<button type="button" id="b">Sign with your wallet</button></form>` +
    `<p id="s" role="status" class="note"></p>` +
    `<p class="note">Agents without a browser wallet: <a href="${esc(cfg.documentation)}">auth.md</a> explains how to sign this request directly.</p>` +
    `<script type="application/json" id="m">${JSON.stringify(message).replace(/</g, '\\u003c')}</script>` +
    `<script src="${OAUTH_PATHS.authorizeScript}"></script>`
  return page(`Sign in · ${cfg.brand}`, body, {
    // The form posts here, and the 303 that follows goes to the client: Chrome applies form-action to it.
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self' ${target}; frame-ancestors 'none'; base-uri 'none'`,
  })
}

const AUTHORIZE_SCRIPT = `(() => {
  const form = document.getElementById('f'), button = document.getElementById('b'), status = document.getElementById('s');
  const m = JSON.parse(document.getElementById('m').textContent);
  button.addEventListener('click', async () => {
    const eth = window.ethereum;
    if (!eth) { status.textContent = 'No browser wallet found. Install one, or follow auth.md to sign without a browser.'; return; }
    button.disabled = true;
    try {
      const [address] = await eth.request({ method: 'eth_requestAccounts' });
      const message = m.before + address + m.after;
      const hex = '0x' + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('');
      const signature = await eth.request({ method: 'personal_sign', params: [hex, address] });
      form.elements.address.value = address;
      form.elements.signature.value = signature;
      form.submit();
    } catch (e) {
      status.textContent = 'Signing was cancelled or failed. You can try again.';
      button.disabled = false;
    }
  });
})();
`

export function authorizeScript(): Response {
  return new Response(AUTHORIZE_SCRIPT, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  })
}
