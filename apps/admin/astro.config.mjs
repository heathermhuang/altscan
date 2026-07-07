import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

export default defineConfig({
  site: 'https://admin.altscan.io',
  output: 'server', // everything is per-request (auth + live data)
  adapter: cloudflare({ imageService: 'compile', platformProxy: { enabled: true } }),
  integrations: [react()],
  vite: {
    resolve: {
      // React 19's react-dom/server default (browser build) references
      // MessageChannel at module scope, which workerd doesn't define —
      // deploy fails with error 10021. The edge build is the supported
      // target for Workers (and runs fine under node in dev).
      alias: { 'react-dom/server': 'react-dom/server.edge' },
    },
  },
});
