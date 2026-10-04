import type { APIRoute } from 'astro';
import { products, type Product } from '../../data/products';
import { buildChainsPayload, fetchJson } from '../../lib/chains';

export const prerender = false;

/** Matches the page's poll interval: at most one upstream call per chain per 12s per location. */
const TTL_S = 12;
const CACHE_CONTROL = `public, max-age=${TTL_S}, s-maxage=${TTL_S}`;


const PAGE = 50;

/** Fetch `tapeBlocks` newest blocks in parallel pages. Page 1 failing means offline; a later page
 *  failing just shortens the history. */
async function fetchBlocks(p: Product): Promise<unknown> {
  const pages = Math.ceil(p.tapeBlocks / PAGE);
  const limit = pages > 1 ? PAGE : p.tapeBlocks;
  const bodies = await Promise.all(
    Array.from({ length: pages }, (_, i) => fetchJson(`${p.url}/api/v1/blocks?limit=${limit}&page=${i + 1}`)),
  );
  const first = bodies[0] as { blocks?: unknown } | null;
  if (!Array.isArray(first?.blocks)) return null;
  return { blocks: bodies.flatMap((b) => ((b as { blocks?: unknown } | null)?.blocks as unknown[] | undefined) ?? []) };
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Workers' default cache. Absent outside workerd, where the route simply fetches every time.
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  // The query string is dropped from the key so `?x=` cannot bypass the cache and reach the explorers.
  const key = new Request(new URL('/api/chains.json', request.url).toString());

  const hit = await cache?.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    // Cloudflare stores cache-API objects with the zone's browser TTL (4h); restore ours on the way out.
    res.headers.set('cache-control', CACHE_CONTROL);
    res.headers.set('x-altscan-cache', 'hit');
    return res;
  }

  const results = await Promise.all(products.map(async (p) => ({ id: p.id, body: await fetchBlocks(p) })));
  const res = new Response(JSON.stringify(buildChainsPayload(results, Date.now())), {
    headers: {
      'content-type': 'application/json',
      'cache-control': CACHE_CONTROL,
      'x-altscan-cache': 'miss',
    },
  });
  if (cache) {
    const put = cache.put(key, res.clone());
    const ctx = (locals as { cfContext?: { waitUntil(promise: Promise<unknown>): void } }).cfContext;
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return res;
};
