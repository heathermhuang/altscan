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

// Colours are CSS variables (app/globals.css, and the chain accents written on
// <html> in app/layout.tsx). A bare `var()` string cannot take Tailwind's `/NN`
// opacity modifier, so resolve it through color-mix when one is requested.
// Without a modifier Tailwind passes undefined, or its own `var(--tw-*-opacity)`:
// both stay a plain var() so the common case works in every browser.
// Tailwind accepts a colour function at runtime; its types list only strings.
const token = (name: string) =>
  (({ opacityValue }: { opacityValue?: string }) =>
    opacityValue === undefined || opacityValue.startsWith('var(')
      ? `var(--${name})`
      : `color-mix(in srgb, var(--${name}) calc(${opacityValue} * 100%), transparent)`) as unknown as string

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  safelist: getAllThemeClasses(),
  theme: {
    extend: {
      colors: {
        ink: token('ink'),
        ink2: token('ink2'),
        mut: token('mut'),
        faint: token('faint'),
        canvas: token('bg'),
        card: token('card'),
        hair: token('hair'),
        hair2: token('hair2'),
        hair3: token('hair3'),
        live: token('live'),
        'live-t': token('liveT'),
        warn: token('warn'),
        'warn-t': token('warnT'),
        band: token('band'),
        acc: token('acc'),
        'acc-ink': token('acc-ink'),
        'acc-t': token('acc-t'),
        'acc-on': token('acc-on'),
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
