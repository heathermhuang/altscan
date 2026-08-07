import { fileURLToPath } from 'node:url';
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
      alias: {
        'react-dom/server': 'react-dom/server.edge',
        // chain-config ships built (main/exports -> ./dist) so the compiled CJS
        // indexer stops require()ing a .ts file through Node's type-stripping.
        // dist/ is gitignored and `astro build` never builds workspace deps, so
        // without this the deploy dies on "[commonjs--resolver] Failed to
        // resolve entry for package @altscan/chain-config" (verified, not
        // theorized). Mirrors apps/explorer/tsconfig.json's paths map: the apps
        // compile it from source and never need dist at all.
        //
        // Vite matches string aliases by PREFIX — safe here only because
        // nothing imports a '@altscan/chain-config/<subpath>'. Add the more
        // specific key FIRST if a subpath export is ever introduced.
        '@altscan/chain-config': fileURLToPath(
          new URL('../../packages/chain-config/src/index.ts', import.meta.url),
        ),
      },
    },
  },
});
