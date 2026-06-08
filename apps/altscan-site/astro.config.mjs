import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://altscan.io',
  output: 'static', // Astro 5: static by default; endpoints opt out via `export const prerender = false`
  adapter: cloudflare({ imageService: 'compile' }),
  integrations: [sitemap()],
});
