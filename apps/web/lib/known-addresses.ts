// Well-known BSC addresses with human-readable labels
export const KNOWN_ADDRESSES: Record<string, { label: string; category: 'exchange' | 'defi' | 'token' | 'bridge' | 'system' }> = {
  '0x10ed43c718714eb63d5aa57b78b54704e256024e': { label: 'PancakeSwap: Router v2', category: 'defi' },
  '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': { label: 'PancakeSwap: Router v3', category: 'defi' },
  '0xca143ce32fe78f1f7019d7d551a6402fc5350c73': { label: 'PancakeSwap: Factory v2', category: 'defi' },
  '0x0000000000000000000000000000000000001000': { label: 'BSC: Validator Contract', category: 'system' },
  '0x0000000000000000000000000000000000001002': { label: 'BSC: Slash Indicator', category: 'system' },
  '0x0000000000000000000000000000000000002000': { label: 'BSC: System Reward', category: 'system' },
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { label: 'WBNB', category: 'token' },
  '0x55d398326f99059ff775485246999027b3197955': { label: 'USDT (BSC)', category: 'token' },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { label: 'USDC (BSC)', category: 'token' },
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': { label: 'BUSD', category: 'token' },
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': { label: 'CAKE', category: 'token' },
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': { label: 'BTCB', category: 'token' },
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': { label: 'ETH (BSC)', category: 'token' },
  '0xf977814e90da44bfa03b6295a0616a897441acec': { label: 'Binance: Hot Wallet 8', category: 'exchange' },
  '0xe2fc31f816a9b94326492132018c3aecc4a93ae1': { label: 'Binance: Hot Wallet 1', category: 'exchange' },
  '0x5a52e96bacdabb82fd05763e25335261b270efcb': { label: 'Binance: Hot Wallet 6', category: 'exchange' },
  '0x4982085c9e2f89f2ecb8131eca71afad896e89cb': { label: 'BSC Bridge', category: 'bridge' },
  '0x0000000000000000000000000000000000000000': { label: 'Null: Burn Address', category: 'system' },
  '0x000000000000000000000000000000000000dead': { label: 'Dead: Burn Address', category: 'system' },
}

export function getAddressLabel(address: string): string | null {
  return KNOWN_ADDRESSES[address.toLowerCase()]?.label ?? null
}

export function getAddressCategory(address: string): string | null {
  return KNOWN_ADDRESSES[address.toLowerCase()]?.category ?? null
}
