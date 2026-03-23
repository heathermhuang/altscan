// Well-known Ethereum addresses with human-readable labels
export const KNOWN_ADDRESSES: Record<string, { label: string; category: 'exchange' | 'defi' | 'token' | 'bridge' | 'system' }> = {
  // Founders / notable wallets
  '0xd8da6bf26964af9d7eed9e03e53415d37aa96045': { label: 'Vitalik Buterin', category: 'system' },
  // Uniswap
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { label: 'Uniswap: Router v2', category: 'defi' },
  '0xe592427a0aece92de3edee1f18e0157c05861564': { label: 'Uniswap: Router v3', category: 'defi' },
  '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f': { label: 'Uniswap: Factory v2', category: 'defi' },
  '0x1f98431c8ad98523631ae4a59f267346ea31f984': { label: 'Uniswap: Factory v3', category: 'defi' },
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { label: 'Uniswap: Permit2', category: 'defi' },
  // Aave
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': { label: 'Aave: Pool v3', category: 'defi' },
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': { label: 'Aave: Pool v2', category: 'defi' },
  // Compound
  '0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b': { label: 'Compound: Comptroller', category: 'defi' },
  '0xc3d688b66703497daa19211eedff47f25384cdc3': { label: 'Compound: USDC v3', category: 'defi' },
  // MakerDAO
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { label: 'MakerDAO: MKR Token', category: 'token' },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { label: 'DAI', category: 'token' },
  // Staking
  '0x00000000219ab540356cbb839cbe05303d7705fa': { label: 'ETH2: Deposit Contract', category: 'system' },
  // Lido
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': { label: 'Lido: stETH', category: 'defi' },
  '0x889edc2edab5f40e902b864ad4d7ade8e412f9b1': { label: 'Lido: Withdrawal Queue', category: 'defi' },
  // Tokens
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { label: 'WETH', category: 'token' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { label: 'USDT (Ethereum)', category: 'token' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { label: 'USDC (Ethereum)', category: 'token' },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { label: 'WBTC', category: 'token' },
  '0x514910771af9ca656af840dff83e8264ecf986ca': { label: 'LINK', category: 'token' },
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { label: 'UNI', category: 'token' },
  // Exchanges
  '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503': { label: 'Binance: Hot Wallet', category: 'exchange' },
  '0xf977814e90da44bfa03b6295a0616a897441acec': { label: 'Binance: Cold Wallet', category: 'exchange' },
  '0x28c6c06298d514db089934071355e5743bf21d60': { label: 'Binance: Hot Wallet 2', category: 'exchange' },
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': { label: 'Binance: Hot Wallet 3', category: 'exchange' },
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': { label: 'Coinbase: Hot Wallet', category: 'exchange' },
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': { label: 'Coinbase: Cold Wallet', category: 'exchange' },
  // System
  '0x0000000000000000000000000000000000000000': { label: 'Null: Burn Address', category: 'system' },
  '0x000000000000000000000000000000000000dead': { label: 'Dead: Burn Address', category: 'system' },
}

export function getAddressLabel(address: string): string | null {
  return KNOWN_ADDRESSES[address.toLowerCase()]?.label ?? null
}

export function getAddressCategory(address: string): string | null {
  return KNOWN_ADDRESSES[address.toLowerCase()]?.category ?? null
}
