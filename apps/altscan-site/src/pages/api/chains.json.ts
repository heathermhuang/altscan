import type { APIRoute } from 'astro';
import { products } from '../../data/products';
import { buildChainsPayload, fetchHealth } from '../../lib/chains';

export const prerender = false;

export const GET: APIRoute = async () => {
  const results = await Promise.all(
    products.map(async (p) => ({ id: p.id, body: await fetchHealth(p.healthUrl) })),
  );
  const payload = buildChainsPayload(results, Date.now());
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
    },
  });
};
