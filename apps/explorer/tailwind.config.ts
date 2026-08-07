import type { Config } from 'tailwindcss'
// Imported by SOURCE PATH, not by package specifier, and that is load-bearing.
// @altscan/chain-config ships built (main/exports -> ./dist) so the compiled CJS
// indexer stops require()ing a .ts file through Node's type-stripping. dist/ is
// gitignored. Every OTHER explorer consumer resolves the package to this same
// source file via apps/explorer/tsconfig.json `paths`, but postcss loads THIS
// file through jiti, which resolves by package.json `exports` and cannot see
// tsconfig paths — so a bare '@altscan/chain-config' here dies with "Cannot find
// module .../dist/index.js" while compiling app/globals.css on any checkout that
// has not built the package (verified 2026-08-07).
//
// Importing the source directly keeps EVERY explorer build path working with no
// dependency-build step: root render.yaml, deploy/render/blueprint.yaml,
// docker/Dockerfile.explorer, and plain `pnpm dev` on a clean clone. Prefer this
// over adding `pnpm --filter @altscan/chain-config build` to each one — that list
// is open-ended, and a missed entry is a broken deploy.
import { getAllThemeClasses } from '../../packages/chain-config/src/index'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  safelist: getAllThemeClasses(),
  theme: {
    extend: {},
  },
  plugins: [],
}

export default config
