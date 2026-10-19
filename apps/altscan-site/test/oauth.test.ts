import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { handleOAuthRequest, type CodeGrant } from '@altscan/oauth';
import { isOAuthPath, mcpCaller, oauthConfig, oauthResponse } from '../src/lib/oauth.ts';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('ok -', name); }

const ORIGIN = 'https://altscan.io';
const SECRET = 'k'.repeat(64);
const codes = () => {
  const m = new Map<string, CodeGrant>();
  return { async put(c: string, g: CodeGrant) { m.set(c, g); }, async take(c: string) { const g = m.get(c) ?? null; m.delete(c); return g; } };
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

await t('oauthConfig: off without a long-enough secret or the code store', () => {
  assert.equal(oauthConfig(ORIGIN, undefined, codes()), null);
  assert.equal(oauthConfig(ORIGIN, 'short', codes()), null);
  assert.equal(oauthConfig(ORIGIN, SECRET, null), null);
  const cfg = oauthConfig(ORIGIN, SECRET, codes())!;
  assert.equal(cfg.issuer, ORIGIN);
  assert.equal(cfg.scope, 'mcp');
  assert.equal(cfg.documentation, `${ORIGIN}/auth.md`);
});

await t('isOAuthPath: the six OAuth paths and nothing else', () => {
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/oauth/register', '/oauth/authorize', '/oauth/authorize.js', '/oauth/token']) {
    assert.ok(isOAuthPath(p), p);
  }
  for (const p of ['/', '/mcp', '/oauth', '/oauth/', '/.well-known/mcp/server-card.json']) assert.ok(!isOAuthPath(p), p);
});

await t('oauthResponse: rate-limits only the minting POSTs', async () => {
  const cfg = oauthConfig(ORIGIN, SECRET, codes())!;
  const deny = async () => false;
  const meta = await oauthResponse(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), cfg, deny);
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).issuer, ORIGIN);
  for (const p of ['/oauth/register', '/oauth/authorize', '/oauth/token']) {
    const res = await oauthResponse(new Request(`${ORIGIN}${p}`, { method: 'POST', body: '{}' }), cfg, deny);
    assert.equal(res.status, 429, p);
  }
});

await t('mcpCaller: per IP without a token or without OAuth; per address with a valid token', async () => {
  const cfg = oauthConfig(ORIGIN, SECRET, codes())!;
  const req = (auth?: string) => new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: auth ? { authorization: auth } : {} });
  assert.deepEqual(await mcpCaller(req(), cfg, '1.2.3.4'), { key: '1.2.3.4' });
  assert.deepEqual(await mcpCaller(req('Bearer whatever'), null, '1.2.3.4'), { key: '1.2.3.4' });
  // A real token, via client_credentials on a config that offers it: same secret and issuer.
  const owner = '0x' + 'cd'.repeat(20);
  const issuing = { ...cfg, clientCredentials: async () => owner };
  const tok = await handleOAuthRequest(new Request(`${ORIGIN}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=a&client_secret=b',
  }), issuing);
  const { access_token } = await tok!.json();
  assert.deepEqual(await mcpCaller(req(`Bearer ${access_token}`), cfg, '1.2.3.4'), { key: `sub:${owner}` });
});

await t('mcpCaller: an invalid token is a 401 a browser client can read', async () => {
  const cfg = oauthConfig(ORIGIN, SECRET, codes())!;
  const r = await mcpCaller(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: 'Bearer not.a.token' } }), cfg, '1.2.3.4');
  assert.ok('reject' in r);
  assert.equal(r.reject.status, 401);
  assert.match(r.reject.headers.get('www-authenticate')!, /^Bearer resource_metadata="https:\/\/altscan\.io\/\.well-known\/oauth-protected-resource", error="invalid_token"/);
  assert.equal(r.reject.headers.get('access-control-expose-headers'), 'www-authenticate');
});

await t('wiring: the Durable Object the config binds is the class the Worker exports', () => {
  const wrangler = read('wrangler.jsonc');
  assert.match(wrangler, /"name": "OAUTH_CODES", "class_name": "OAuthCodes"/);
  assert.match(wrangler, /"new_sqlite_classes": \["OAuthCodes"\]/);
  assert.match(read('src/worker.ts'), /export \{ OAuthCodes \} from '\.\/oauth-codes';/);
});

await t('auth.md: names every OAuth endpoint it tells an agent to call', () => {
  const md = read('public/auth.md');
  assert.match(md.split('\n')[0], /^# .*auth\.md$/);
  for (const line of ['POST /oauth/register HTTP/1.1', 'GET /oauth/authorize?', 'POST /oauth/authorize HTTP/1.1', 'POST /oauth/token HTTP/1.1', '/.well-known/oauth-protected-resource']) {
    assert.ok(md.includes(line), line);
  }
});

console.log(`\n${passed} passed`);
