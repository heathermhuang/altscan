import type { Config } from 'tailwindcss'
import { getAllThemeClasses } from '@bnbscan/chain-config'

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
