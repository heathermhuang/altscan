// Worker entry (wrangler.jsonc `main`). Everything goes to Astro's handler except `/`, which
// run_worker_first routes here before the asset layer so it can negotiate HTML vs Markdown, and
// `/mcp` and the OAuth paths, which no asset matches.
import { handle } from '@astrojs/cloudflare/handler';
import type { CodeGrant } from '@altscan/oauth';
import { homeResponse } from './lib/home';
import { clientHash, handleMcp, usagePoint, type UsagePoint } from './lib/mcp';
import { isOAuthPath, mcpCaller, oauthConfig, oauthResponse } from './lib/oauth';

export { OAuthCodes } from './oauth-codes';

type RateLimit = { limit(o: { key: string }): Promise<{ success: boolean }> };

type Handle = typeof handle;
type Env = {
  ASSETS: { fetch(r: Request): Promise<Response> };
  /** Kill switch: /mcp answers only while this is "true" (wrangler.jsonc vars, editable in the dashboard). */
  MCP_ENABLED?: string;
  /** Per-client limit for /mcp (wrangler.jsonc ratelimits). */
  MCP_RATE_LIMITER?: RateLimit;
  /** Secret shared with the explorers, which give it its own rate-limit bucket. */
  ALTSCAN_SERVICE_TOKEN?: string;
  /** One row per tool call, for the pilot's usage report (wrangler.jsonc analytics_engine_datasets). */
  MCP_USAGE?: { writeDataPoint(point: UsagePoint): void };
  /** HMAC root of the OAuth server (a Worker secret). Unset: no OAuth, /mcp keyless only. */
  OAUTH_SECRET?: string;
  /** The Durable Object holding single-use authorization codes (src/oauth-codes.ts). */
  OAUTH_CODES?: {
    idFromName(name: string): unknown;
    get(id: unknown): { put(code: string, grant: CodeGrant, ttl: number): Promise<void>; take(code: string): Promise<CodeGrant | null> };
  };
  /** Per-IP limit on the OAuth endpoints that mint something (wrangler.jsonc ratelimits). */
  OAUTH_RATE_LIMITER?: RateLimit;
};

function oauthFor(request: Request, env: Env) {
  const ns = env.OAUTH_CODES;
  const codes = ns ? ns.get(ns.idFromName('codes')) : null;
  return oauthConfig(new URL(request.url).origin, env.OAUTH_SECRET, codes);
}

async function oauth(request: Request, env: Env, fallback: () => Promise<Response>): Promise<Response> {
  const cfg = oauthFor(request, env);
  if (!cfg) return fallback();
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  return oauthResponse(request, cfg, async () => !env.OAUTH_RATE_LIMITER || (await env.OAUTH_RATE_LIMITER.limit({ key: ip })).success);
}

const MCP_UPSTREAM_DEADLINE_MS = 10_000;

async function mcp(request: Request, env: Env): Promise<Response> {
  if (env.MCP_ENABLED !== 'true') {
    return new Response(JSON.stringify({ error: 'The Altscan MCP endpoint is paused.' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'retry-after': '3600' },
    });
  }
  // The explorers see every Worker request as one client, so the per-client limit lives here: per IP,
  // or per address for a caller with a valid OAuth token.
  const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const caller = await mcpCaller(request, oauthFor(request, env), client);
  if ('reject' in caller) return caller.reject;
  if (env.MCP_RATE_LIMITER && !(await env.MCP_RATE_LIMITER.limit({ key: caller.key })).success) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'altscan-mcp/0.1 (+https://altscan.io)' };
  if (env.ALTSCAN_SERVICE_TOKEN) headers['x-altscan-service-token'] = env.ALTSCAN_SERVICE_TOKEN;
  const upstream = (url: string) => fetch(url, { headers, signal: AbortSignal.timeout(MCP_UPSTREAM_DEADLINE_MS) });
  // One line per tool call: tool, chain, outcome, upstream status, latency. No hashes or addresses.
  // The usage row adds the client, hashed, so distinct clients can be counted over the whole pilot.
  const hashed = env.MCP_USAGE ? await clientHash(client) : '';
  return handleMcp(request, upstream, (line) => {
    console.log(JSON.stringify({ mcp: line }));
    // This runs in handleMcp's `finally`: a throw here would turn the tool's answer into a 500.
    try { env.MCP_USAGE?.writeDataPoint(usagePoint(line, hashed)); } catch { /* usage row lost, call unaffected */ }
  });
}

export default {
  fetch(request: Request, env: Parameters<Handle>[1], ctx: Parameters<Handle>[2]) {
    const { pathname } = new URL(request.url);
    if (pathname === '/') {
      return homeResponse(request, (env as unknown as Env).ASSETS);
    }
    if (pathname === '/mcp') return mcp(request, env as unknown as Env);
    if (isOAuthPath(pathname)) return oauth(request, env as unknown as Env, () => handle(request, env, ctx));
    return handle(request, env, ctx);
  },
};
