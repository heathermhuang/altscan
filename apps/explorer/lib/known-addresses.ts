/**
 * Human-readable labels for well-known addresses, keyed BY CHAIN.
 *
 * ⚠ This table used to be a single flat map of BSC addresses consulted on both
 * products. Ethereum addresses are a different address space, so every BSC entry
 * was also being applied on ethscan.io. Two of them are live, unrelated
 * Ethereum addresses:
 *
 *   0x2170ed08… — labelled "ETH (BSC)"; on Ethereum it holds 217 ETH and is
 *                 an entirely different account.
 *   0x55d39832… — labelled "USDT (BSC)"; on Ethereum, Etherscan flags it
 *                 "Blocked — Phish / Hack".
 *
 * Presenting a flagged phishing address to a user as "USDT" is strictly worse
 * than showing no label at all, so the chain dimension is not optional here.
 * `known-addresses.test.ts` pins that neither table can leak onto the other.
 *
 * Every Ethereum entry below was verified against the label Etherscan itself
 * publishes for that address. Do not add an entry from memory — an address you
 * cannot verify must stay unlabelled.
 */
import { chainConfig } from './chain'

export type AddressCategory = 'exchange' | 'defi' | 'token' | 'bridge' | 'system'
export type AddressLabel = { label: string; category: AddressCategory }
export type ChainKey = 'bnb' | 'eth'

/** Chain-agnostic: the same burn sinks exist on every EVM chain. */
export const SHARED_ADDRESSES: Record<string, AddressLabel> = {
  '0x0000000000000000000000000000000000000000': { label: 'Null: Burn Address', category: 'system' },
  '0x000000000000000000000000000000000000dead': { label: 'Dead: Burn Address', category: 'system' },
}

export const BNB_ADDRESSES: Record<string, AddressLabel> = {
  ...SHARED_ADDRESSES,
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
}

/** Each entry verified against Etherscan's own published label. */
export const ETH_ADDRESSES: Record<string, AddressLabel> = {
  ...SHARED_ADDRESSES,
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { label: 'Wrapped Ether', category: 'token' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { label: 'Circle: USDC Token', category: 'token' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { label: 'Tether: USDT Stablecoin', category: 'token' },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { label: 'Sky: Dai Stablecoin', category: 'token' },
  '0x00000000219ab540356cbb839cbe05303d7705fa': { label: 'Beacon Deposit Contract', category: 'system' },
  '0x7830c87c02e56aff27fa8ab1241711331fa86f43': { label: 'Coinbase: Deposit', category: 'exchange' },
}

const TABLES: Record<ChainKey, Record<string, AddressLabel>> = {
  bnb: BNB_ADDRESSES,
  eth: ETH_ADDRESSES,
}

/** Pure, chain-explicit lookup. Testable without touching the CHAIN env var. */
export function getLabelForChain(chain: ChainKey, address: string): AddressLabel | null {
  if (!address) return null
  return TABLES[chain]?.[address.toLowerCase()] ?? null
}

export function getAddressLabel(address: string): string | null {
  return getLabelForChain(chainConfig.key as ChainKey, address)?.label ?? null
}

export function getAddressCategory(address: string): string | null {
  return getLabelForChain(chainConfig.key as ChainKey, address)?.category ?? null
}
