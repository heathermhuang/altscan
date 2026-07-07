import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

export default defineConfig({
  site: 'https://admin.altscan.io',
  output: 'server', // everything is per-request (auth + live data)
  adapter: cloudflare({ imageService: 'compile', platformProxy: { enabled: true } }),
  integrations: [react()],
});
