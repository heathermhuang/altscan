// altscan.io's OAuth 2.1 server (packages/oauth) and what its tokens do here: /mcp keeps working with
// no credential, and a valid bearer token moves the caller from its IP's rate limit to its address's.
// Off, with every OAuth path a 404, until the Worker has OAUTH_SECRET and the OAUTH_CODES binding.
import {
  MIN_SECRET_LENGTH,
  OAUTH_PATHS,
  handleOAuthRequest,
  verifyBearer,
  wwwAuthenticate,
  type CodeStore,
  type OAuthConfig,
} from '@altscan/oauth';

/** The issuer is the origin the request came to: altscan.io in production, a preview URL in a preview. */
export function oauthConfig(origin: string, secret: string | undefined, codes: CodeStore | null): OAuthConfig | null {
  if (!codes || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  return {
    issuer: origin,
    secret,
    brand: 'Altscan',
    scope: 'mcp',
    scopeLabel: 'the Altscan MCP server',
    chainId: 1,
    codes,
    documentation: `${origin}/auth.md`,
  };
}

const PATHS = new Set<string>(Object.values(OAUTH_PATHS));
/** The endpoints that mint something. Discovery documents and the page script are not limited. */
const MINTING = new Set<string>([OAUTH_PATHS.register, OAUTH_PATHS.authorize, OAUTH_PATHS.token]);

export function isOAuthPath(pathname: string): boolean {
  return PATHS.has(pathname);
}

export async function oauthResponse(request: Request, cfg: OAuthConfig, allow: () => Promise<boolean>): Promise<Response> {
  if (request.method === 'POST' && MINTING.has(new URL(request.url).pathname) && !(await allow())) {
    return new Response(JSON.stringify({ error: 'slow_down', error_description: 'Too many requests; retry in a minute.' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60', 'access-control-allow-origin': '*' },
    });
  }
  return (await handleOAuthRequest(request, cfg)) ?? new Response('Not found', { status: 404 });
}

/**
 * The rate-limit key for an /mcp request: its IP without a token, `sub:<address>` with a valid one.
 * A token that does not verify is refused (RFC 6750 §3.1), pointing the client at the metadata.
 */
export async function mcpCaller(request: Request, cfg: OAuthConfig | null, ip: string): Promise<{ key: string } | { reject: Response }> {
  if (!cfg) return { key: ip };
  const bearer = await verifyBearer(request.headers.get('authorization'), cfg);
  if (bearer === 'invalid') {
    return {
      reject: new Response(JSON.stringify({ error: 'invalid_token', error_description: 'The access token is invalid or expired. /mcp also works without one.' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': wwwAuthenticate(cfg, true),
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'www-authenticate',
        },
      }),
    };
  }
  return { key: bearer ? `sub:${bearer.sub}` : ip };
}

type RateLimiter = { limit(o: { key: string }): Promise<{ success: boolean }> };

/**
 * /mcp's per-client limits. A token caller gets a bucket per address, so agents sharing
 * one IP don't throttle each other. But an address costs only a wallet signature, so one
 * IP could open hundreds and, between them, drain the single bucket the explorers give
 * all of altscan.io. Token callers are therefore also limited per IP, more loosely
 * (`perIp`), which bounds what one IP can draw however many addresses it opens.
 * An unbound limiter (local dev) allows.
 */
export async function mcpWithinLimits(
  callerKey: string,
  ip: string,
  limiters: { perCaller?: RateLimiter; perIp?: RateLimiter },
): Promise<boolean> {
  if (limiters.perCaller && !(await limiters.perCaller.limit({ key: callerKey })).success) return false;
  if (callerKey.startsWith('sub:') && limiters.perIp && !(await limiters.perIp.limit({ key: ip })).success) return false;
  return true;
}
