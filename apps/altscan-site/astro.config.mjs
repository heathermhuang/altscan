import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://altscan.io',
  output: 'static', // Astro 5: static by default; endpoints opt out via `export const prerender = false`
  adapter: cloudflare({ imageService: 'compile' }),
  integrations: [sitemap()],
  vite: {
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
