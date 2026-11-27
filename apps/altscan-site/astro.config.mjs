import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://altscan.io',
  // Astro 7 defaults to JSX-style whitespace, which drops the spaces between inline elements written
  // on separate lines (the anatomy paragraph's links, for one). Keep HTML-aware compression.
  compressHTML: true,
  // No sessions here. Without this the adapter defaults to KV-backed sessions and adds a SESSION
  // binding with no id, which wrangler would provision as a new KV namespace on deploy.
  session: false,
  output: 'static', // Astro 5: static by default; endpoints opt out via `export const prerender = false`
  // Prerender under Node: the code tape (src/lib/codebase.ts) reads the repository with git and fs.
  adapter: cloudflare({ imageService: 'compile', prerenderEnvironment: 'node' }),
  // The sitemap finds /changelog as /changelog/. List the canonical URL instead, once.
  integrations: [
    sitemap({
      customPages: ['https://altscan.io/changelog'],
      filter: (page) => page !== 'https://altscan.io/changelog/',
    }),
  ],
  vite: {
    resolve: {
      alias: {
        // chain-config ships built (main -> ./dist), dist/ is gitignored, and `astro build`
        // never builds workspace deps: compile it from source, as apps/admin does. Vite
        // matches string aliases by PREFIX; nothing imports a subpath, so this key is safe.
        '@altscan/chain-config': fileURLToPath(new URL('../../packages/chain-config/src/index.ts', import.meta.url)),
      },
    },
    build: {
      // Never inline bundled component scripts into the HTML. The _headers CSP
      // is `script-src 'self' https://static.cloudflareinsights.com` (no
      // 'unsafe-inline'/nonce), so an inlined <script type="module"> would be
      // blocked by the browser (LiveChains' block-height fetch was inlined at
      // the default 4096-byte threshold). External /_astro/*.js passes 'self'.
      assetsInlineLimit: 0,
    },
  },
});
