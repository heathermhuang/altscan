export type ChainTheme = {
  /** Tailwind bg class for header/buttons, e.g. "bg-yellow-400" */
  headerBg: string
  /** Tailwind text class for links/highlights, e.g. "text-yellow-600" */
  linkText: string
  /** Tailwind text class for hover, e.g. "hover:text-yellow-700" */
  linkHover: string
  /** Tailwind border class, e.g. "border-yellow-400" */
  border: string
  /** Tailwind focus-ring class, e.g. "focus:ring-yellow-500" */
  focusRing: string
  /** Tailwind active nav bg, e.g. "bg-black/15" */
  activeNav: string
  /** Hex color for favicon/og images */
  primaryHex: string
  /** Button bg (search, submit), e.g. "bg-black" */
  buttonBg: string
  /** Button text color, e.g. "text-yellow-400" */
  buttonText: string
}

export type ChainFeatures = {
  /** Has a validator/staking page */
  hasValidators: boolean
  /** Has DEX analytics */
  hasDex: boolean
  /** Supports ENS name resolution */
  hasEns: boolean
  /** Uses EIP-1559 base fee + priority fee */
  hasEip1559: boolean
}

export type ChainConfig = {
  /** EVM chain ID */
  chainId: number
  /** Full chain name, e.g. "BNB Chain" */
  name: string
  /** Short currency ticker, e.g. "BNB" */
  currency: string
  /** Product brand name, e.g. "BNBScan" */
  brandName: string
  /** Tagline shown in header/footer */
  tagline: string
  /** Primary domain */
  domain: string
  /** Average block time in seconds */
  blockTime: number
  /** CoinGecko coin ID for price fetch */
  coingeckoId: string
  /** Env var name for RPC URL */
  rpcEnvVar: string
  /** Env var name for DB URL */
  dbEnvVar: string
  /** Visual theme tokens */
  theme: ChainTheme
  /** Feature flags */
  features: ChainFeatures
}

export const BSC: ChainConfig = {
  chainId: 56,
  name: 'BNB Chain',
  currency: 'BNB',
  brandName: 'BNBScan',
  tagline: 'The Alternative BNB Chain Explorer',
  domain: 'bnbscan.com',
  blockTime: 3,
  coingeckoId: 'binancecoin',
  rpcEnvVar: 'BNB_RPC_URL',
  dbEnvVar: 'DATABASE_URL',
  theme: {
    headerBg: 'bg-yellow-400',
    linkText: 'text-yellow-600',
    linkHover: 'hover:text-yellow-700',
    border: 'border-yellow-400',
    focusRing: 'focus:ring-yellow-500',
    activeNav: 'bg-black/15',
    primaryHex: '#FACC15',
    buttonBg: 'bg-black',
    buttonText: 'text-yellow-400',
  },
  features: {
    hasValidators: true,
    hasDex: true,
    hasEns: false,
    hasEip1559: false,
  },
}

export const ETH: ChainConfig = {
  chainId: 1,
  name: 'Ethereum',
  currency: 'ETH',
  brandName: 'EthScan',
  tagline: 'The Alternative Ethereum Explorer',
  domain: 'ethscan.io',
  blockTime: 12,
  coingeckoId: 'ethereum',
  rpcEnvVar: 'ETH_RPC_URL',
  dbEnvVar: 'ETH_DATABASE_URL',
  theme: {
    headerBg: 'bg-indigo-600',
    linkText: 'text-indigo-600',
    linkHover: 'hover:text-indigo-700',
    border: 'border-indigo-500',
    focusRing: 'focus:ring-indigo-500',
    activeNav: 'bg-white/20',
    primaryHex: '#4F46E5',
    buttonBg: 'bg-indigo-700',
    buttonText: 'text-white',
  },
  features: {
    hasValidators: false,
    hasDex: true,
    hasEns: true,
    hasEip1559: true,
  },
}

/** All supported chains */
export const CHAINS = { BSC, ETH } as const
export type ChainKey = keyof typeof CHAINS
