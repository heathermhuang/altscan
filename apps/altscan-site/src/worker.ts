// Worker entry (wrangler.jsonc `main`). Everything goes to Astro's handler except `/`, which
// run_worker_first routes here before the asset layer so it can negotiate HTML vs Markdown.
import { handle } from '@astrojs/cloudflare/handler';
import { homeResponse } from './lib/home';

type Handle = typeof handle;

export default {
  fetch(request: Request, env: Parameters<Handle>[1], ctx: Parameters<Handle>[2]) {
    if (new URL(request.url).pathname === '/') {
      return homeResponse(request, (env as unknown as { ASSETS: { fetch(r: Request): Promise<Response> } }).ASSETS);
    }
    return handle(request, env, ctx);
  },
};
