import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace DB package to its TS source instead of its
      // compiled ./dist entry. dist/ is gitignored and CI runs `vitest` with
      // no prior build step, so the package's main/exports (./dist/client.js)
      // does not exist in CI → "Failed to resolve entry for package @altscan/db".
      // Pointing at the source lets vitest transform it on the fly (build-free).
      '@altscan/db': fileURLToPath(new URL('./packages/db/client.ts', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      // Git worktrees live under .claude/ and duplicate every test file —
      // they aren't part of a fresh CI checkout, but pollute local runs.
      '**/.claude/**',
      // altscan-site ships its own tsx-based harness (`pnpm --filter
      // altscan-site test` → `tsx test/chains.test.ts`), not vitest suites.
      // Without this, vitest collects it and fails: "No test suite found".
      'apps/altscan-site/**',
    ],
    environment: 'node',
  },
})
