export type ChainTheme = {
  /** Tailwind bg class for header/buttons, e.g. "bg-yellow-400" */
  headerBg: string
  /** Tailwind text color for header, e.g. "text-black" */
  headerText: string
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
  /** Search input border, e.g. "border-yellow-200" */
  searchBorder: string
  /** Search input focus ring, e.g. "focus:ring-yellow-500" */
  searchFocusRing: string
  /** Footer accent link color, e.g. "text-yellow-400" */
  footerAccent: string
  /** Footer powered-by link color, e.g. "text-yellow-500" */
  footerPoweredBy: string
  /** Network switcher hover bg in header, e.g. "bg-black/25" */
  switcherHoverBg: string
  /** Network switcher border in header, e.g. "border-black/15" */
  switcherBorder: string
  /** Stat subtext color for positive change, e.g. "text-green-600" */
  positiveChange: string
  /** Stat subtext color for negative change, e.g. "text-red-500" */
  negativeChange: string
}

export type ChainFeatures = {
  /** Has a validator page (BNB) */
  hasValidators: boolean
  /** Has a staking page (ETH) */
  hasStaking: boolean
  /** Has DEX analytics */
  hasDex: boolean
  /** Supports ENS name resolution */
  hasEns: boolean
  /** Uses EIP-1559 base fee + priority fee */
  hasEip1559: boolean
}

export type ChainConfig = {
  /** Chain key for env var resolution */
  key: string
  /** EVM chain ID */
  chainId: number
  /** Full chain name, e.g. "BNB Chain" */
  name: string
  /** Short currency ticker, e.g. "BNB" */
  currency: string
  /** Product brand name, e.g. "BNBScan" */
  brandName: string
  /** Full product domain name, e.g. "BNBScan.com" */
  brandDomain: string
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
  /** Default RPC URL fallback */
  defaultRpcUrl: string
  /** Default start block for indexer */
  defaultStartBlock: number
  /** Poll interval in ms (matches block time) */
  pollMs: number
  /** Google Analytics tracking ID */
  gaTrackingId: string
  /** Peer explorer URL for network switcher */
  peerUrl: string
  /** Peer dev URL for local development */
  peerDevUrl: string
  /** External block explorer domain for "View on X" links */
  externalExplorer: string
  /** External block explorer base URL */
  externalExplorerUrl: string
  /** L1 chain name for "Powered by" in footer */
  poweredBy: string
  /** L1 chain URL for "Powered by" link */
  poweredByUrl: string
  /** Moralis chain identifier */
  moralisChain: string
  /** Visual theme tokens */
  theme: ChainTheme
  /** Feature flags */
  features: ChainFeatures
}

export const BSC: ChainConfig = {
  key: 'bnb',
  chainId: 56,
  name: 'BNB Chain',
  currency: 'BNB',
  brandName: 'BNBScan',
  brandDomain: 'BNBScan.com',
  tagline: 'The Alternative BNB Chain Explorer',
  domain: 'bnbscan.com',
  blockTime: 3,
  coingeckoId: 'binancecoin',
  rpcEnvVar: 'BNB_RPC_URL',
  dbEnvVar: 'DATABASE_URL',
  defaultRpcUrl: 'https://bsc-dataseed1.binance.org/',
  defaultStartBlock: 38000000,
  pollMs: 3_000,
  gaTrackingId: 'G-BCLL9EVN8Z',
  peerUrl: 'https://ethscan.io',
  peerDevUrl: 'http://localhost:3001',
  externalExplorer: 'BscScan',
  externalExplorerUrl: 'https://bscscan.com',
  poweredBy: 'BNB Chain',
  poweredByUrl: 'https://www.bnbchain.org',
  moralisChain: '0x38',
  theme: {
    headerBg: 'bg-yellow-400',
    headerText: 'text-black',
    linkText: 'text-yellow-600',
    linkHover: 'hover:text-yellow-700',
    border: 'border-yellow-400',
    focusRing: 'focus:ring-yellow-500',
    activeNav: 'bg-black/15',
    primaryHex: '#FACC15',
    buttonBg: 'bg-black',
    buttonText: 'text-yellow-400',
    searchBorder: 'border-yellow-200',
    searchFocusRing: 'focus:ring-yellow-500',
    footerAccent: 'text-yellow-400',
    footerPoweredBy: 'text-yellow-500',
    switcherHoverBg: 'bg-black/25',
    switcherBorder: 'border-black/15',
    positiveChange: 'text-green-600',
    negativeChange: 'text-red-500',
  },
  features: {
    hasValidators: true,
    hasStaking: false,
    hasDex: true,
    hasEns: false,
    hasEip1559: false,
  },
}

export const ETH: ChainConfig = {
  key: 'eth',
  chainId: 1,
  name: 'Ethereum',
  currency: 'ETH',
  brandName: 'EthScan',
  brandDomain: 'EthScan.io',
  tagline: 'The Alternative Ethereum Explorer',
  domain: 'ethscan.io',
  blockTime: 12,
  coingeckoId: 'ethereum',
  rpcEnvVar: 'ETH_RPC_URL',
  dbEnvVar: 'ETH_DATABASE_URL',
  defaultRpcUrl: 'https://eth.llamarpc.com',
  defaultStartBlock: 0,
  pollMs: 12_000,
  gaTrackingId: 'G-DRSRLLSRMC',
  peerUrl: 'https://bnbscan.com',
  peerDevUrl: 'http://localhost:3000',
  externalExplorer: 'Etherscan',
  externalExplorerUrl: 'https://etherscan.io',
  poweredBy: 'Ethereum',
  poweredByUrl: 'https://ethereum.org',
  moralisChain: '0x1',
  theme: {
    headerBg: 'bg-blue-900',
    headerText: 'text-white',
    linkText: 'text-blue-600',
    linkHover: 'hover:text-blue-700',
    border: 'border-blue-500',
    focusRing: 'focus:ring-blue-500',
    activeNav: 'bg-white/20',
    primaryHex: '#1E3A8A',
    buttonBg: 'bg-blue-700',
    buttonText: 'text-white',
    searchBorder: 'border-blue-200',
    searchFocusRing: 'focus:ring-blue-400',
    footerAccent: 'text-blue-400',
    footerPoweredBy: 'text-blue-300',
    switcherHoverBg: 'bg-white/25',
    switcherBorder: 'border-white/20',
    positiveChange: 'text-green-600',
    negativeChange: 'text-red-500',
  },
  features: {
    hasValidators: false,
    hasStaking: true,
    hasDex: true,
    hasEns: true,
    hasEip1559: true,
  },
}

/** All supported chains */
export const CHAINS = { bnb: BSC, eth: ETH } as const
export type ChainKey = keyof typeof CHAINS

/** Get chain config by key */
export function getChainConfig(key?: string): ChainConfig {
  const k = (key ?? process.env.CHAIN ?? 'bnb') as ChainKey
  const config = CHAINS[k]
  if (!config) throw new Error(`Unknown chain: ${k}. Valid: ${Object.keys(CHAINS).join(', ')}`)
  return config
}

/** Get all theme classes for Tailwind safelist */
export function getAllThemeClasses(): string[] {
  return Object.values(CHAINS).flatMap(c => Object.values(c.theme))
}
