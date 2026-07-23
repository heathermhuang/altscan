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

/** Historical-data provider for established chains (spec §3.5). null = no
 *  provider: the chain serves local-index data only (fine for a new chain —
 *  it indexes forward from launch and never needs deep backfill). */
export type DataProviderConfig = {
  kind: 'moralis'
  /** Moralis chain identifier (hex chain id), e.g. "0x38" */
  moralisChain: string
  /** Lazy provider backfill (Track A4b). Absent or false = provider-live
   *  passthrough only (A4a behavior). true = the indexer worker caches deep
   *  history into the immortal `backfill_*` tables and the explorer serves
   *  `live head ∪ cached tail`.
   *
   *  Absent MUST behave exactly like false: a new chain that never sets this
   *  field must not silently opt into provider spend. Read it as
   *  `provider?.backfill?.enabled === true`, never as a truthiness check on
   *  the `backfill` object itself. */
  backfill?: { enabled: boolean }
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
  /** Confirmation depth K — only the last K blocks are considered mutable (the
   *  reorg window). Fork search and rollback are bounded to K (spec invariant 4).
   *  BSC: Maxwell-era fast-finality reorgs observed up to ~10-12 → 15 with margin.
   *  ETH: PoS single-slot reorgs are 1-2 → 3 with margin. */
  reorgDepth: number
  /** CoinGecko coin ID for price fetch */
  coingeckoId: string
  /** Fallback circulating supply for the native coin, used to derive market cap as
   *  price × supply when the market-cap APIs fail (they're unreliable from datacenter
   *  IPs, but the Binance price is not). Self-refined at runtime from any successful cap
   *  fetch (impliedSupply = reportedCap / price), so this is only the seed estimate —
   *  a few % drift from quarterly burns is fine. */
  nativeCirculatingSupply: number
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
  /** Disclaimer text for footer — not affiliated with */
  notAffiliatedWith: string
  /** Historical-data provider config; null = forward-only chain, no provider */
  provider: DataProviderConfig | null
  /** CoinGecko asset-platform id for /coins/{platform}/contract lookups, e.g. "binance-smart-chain" */
  coingeckoPlatform: string
  /** DexScreener chainId filter for the /tokens endpoint, e.g. "bsc" */
  dexscreenerChain: string
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
  reorgDepth: 15,
  coingeckoId: 'binancecoin',
  nativeCirculatingSupply: 134_500_000, // ~implied from live cap/price; self-refines at runtime
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
  notAffiliatedWith: 'BscScan or Binance',
  provider: { kind: 'moralis', moralisChain: '0x38', backfill: { enabled: false } },
  coingeckoPlatform: 'binance-smart-chain',
  dexscreenerChain: 'bsc',
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
  reorgDepth: 3,
  coingeckoId: 'ethereum',
  nativeCirculatingSupply: 120_700_000, // ~ETH circulating; self-refines at runtime
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
  notAffiliatedWith: 'Etherscan or the Ethereum Foundation',
  provider: { kind: 'moralis', moralisChain: '0x1', backfill: { enabled: false } },
  coingeckoPlatform: 'ethereum',
  dexscreenerChain: 'ethereum',
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

/**
 * Whether lazy backfill (Track A4b) is ON, resolving the per-chain config flag
 * against an optional `BACKFILL_ENABLED` env override:
 *
 *   'true' | '1'  → ON  — a no-deploy enable (config flag stays false; env drives)
 *   'false' | '0' → OFF — a no-deploy kill switch ('0' is the historical value,
 *                         kept for back-compat with the earlier explorer/worker gates)
 *   unset / other → the per-chain `provider.backfill.enabled`, read strictly as
 *                   `=== true` so an absent `backfill` object is as safe as false
 *
 * Read this on BOTH A4b gates — the explorer serve path and the indexer worker —
 * so a chain flips on or off (or rolls back) with one env change on its two
 * services: no code deploy, no chain-config edit, symmetric in both directions.
 */
export function isBackfillEnabled(
  config: ChainConfig,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const override = env.BACKFILL_ENABLED
  if (override === 'true' || override === '1') return true
  if (override === 'false' || override === '0') return false
  return config.provider?.backfill?.enabled === true
}

/** Get all theme classes for Tailwind safelist */
export function getAllThemeClasses(): string[] {
  return Object.values(CHAINS).flatMap(c => Object.values(c.theme))
}
