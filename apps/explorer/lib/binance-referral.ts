import type { ChainConfig } from '@bnbscan/chain-config'

export type BinanceReferralContext =
  | 'home'
  | 'gas'
  | 'address_low_balance'
  | 'address_zero_balance'
  | 'address_copy'
  | 'tx_failed'
  | 'token_research'
  | 'stablecoin'
  | 'dex'
  | 'staking'
  | 'whales'
  | 'watchlist_empty'
  | 'watchlist_active'
  | 'search_intent'
  | 'developer'
  | 'api_docs'
  | 'verify'
  | 'not_found'
  | 'footer'

export type BinanceReferralVariant = 'card' | 'compact' | 'inline' | 'footer' | 'popover'

export type BinanceReferralPlacement =
  | 'home_after_stats'
  | 'gas_top'
  | 'address_low_balance'
  | 'address_zero_balance'
  | 'address_copy'
  | 'tx_failed'
  | 'token_research'
  | 'token_stablecoin'
  | 'dex_after_stats'
  | 'staking_after_stats'
  | 'whales_before_table'
  | 'watchlist_empty'
  | 'watchlist_active'
  | 'search_results'
  | 'search_no_results'
  | 'developer_after_links'
  | 'api_docs_intro'
  | 'verify_intro'
  | 'not_found'
  | 'footer_strip'

export const BINANCE_RESTRICTED_COUNTRIES = new Set([
  'US',
  'AS',
  'GU',
  'MP',
  'PR',
  'UM',
  'VI',
])

export function isBinanceRestrictedCountry(country: string | null | undefined): boolean {
  if (!country) return false
  return BINANCE_RESTRICTED_COUNTRIES.has(country.trim().toUpperCase())
}

export function getBinanceReferralUrl(chainKey: string): string {
  const ref = chainKey === 'eth' ? 'ETHSCAN' : 'BNBSCAN'
  return `https://www.binance.com/register?ref=${ref}`
}

export function isBinanceIntentQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return false
  return [
    'bnb',
    'eth',
    'binance',
    'gas',
    'buy',
    'trade',
    'swap',
    'usdt',
    'usdc',
    'stablecoin',
  ].some((term) => normalized.includes(term))
}

export function isStablecoinToken(symbol: string | null | undefined, name?: string | null): boolean {
  const haystack = `${symbol ?? ''} ${name ?? ''}`.toLowerCase()
  return ['usdt', 'usdc', 'busd', 'dai', 'fdusd', 'tusd', 'usde', 'stablecoin'].some((term) =>
    haystack.includes(term),
  )
}

export function getBinanceReferralCopy(
  context: BinanceReferralContext,
  chain: Pick<ChainConfig, 'currency' | 'name' | 'key'>,
): { eyebrow: string; title: string; body: string; cta: string } {
  const currency = chain.currency
  const cta = `Buy ${currency} on Binance`

  switch (context) {
    case 'gas':
      return {
        eyebrow: 'Sponsored',
        title: `Need ${currency} for gas?`,
        body: `Fund your wallet before your next ${chain.name} transaction.`,
        cta,
      }
    case 'address_low_balance':
      return {
        eyebrow: 'Sponsored',
        title: `Low ${currency} balance`,
        body: `This wallet may need more ${currency} for network fees.`,
        cta,
      }
    case 'address_zero_balance':
      return {
        eyebrow: 'Sponsored',
        title: `No ${currency} for gas`,
        body: `Add ${currency} before sending tokens or interacting with contracts.`,
        cta,
      }
    case 'address_copy':
      return {
        eyebrow: 'Sponsored',
        title: 'Sending funds?',
        body: `Open Binance after copying the address.`,
        cta,
      }
    case 'tx_failed':
      return {
        eyebrow: 'Sponsored',
        title: 'Retrying this transaction?',
        body: `Check that your wallet has enough ${currency} for gas first.`,
        cta,
      }
    case 'token_research':
      return {
        eyebrow: 'Sponsored',
        title: 'Research here, trade when ready',
        body: 'Use on-chain activity to inform your next move.',
        cta,
      }
    case 'stablecoin':
      return {
        eyebrow: 'Sponsored',
        title: 'Moving stablecoins?',
        body: `Swap between stablecoins and ${currency} when you need gas or liquidity.`,
        cta,
      }
    case 'dex':
      return {
        eyebrow: 'Sponsored',
        title: 'Prefer centralized liquidity?',
        body: 'Track swaps on-chain here, then continue on Binance when ready.',
        cta,
      }
    case 'staking':
      return {
        eyebrow: 'Sponsored',
        title: `Staking or moving ${currency}?`,
        body: `Keep ${currency} ready for deposits, withdrawals, and validator operations.`,
        cta,
      }
    case 'whales':
      return {
        eyebrow: 'Sponsored',
        title: 'Tracking market moves?',
        body: `Monitor large flows here, then act on Binance when you choose.`,
        cta,
      }
    case 'watchlist_empty':
      return {
        eyebrow: 'Sponsored',
        title: 'Watching wallets?',
        body: `Keep ${currency} ready for the next transaction you want to make.`,
        cta,
      }
    case 'watchlist_active':
      return {
        eyebrow: 'Sponsored',
        title: 'Monitor here, act on Binance',
        body: `Keep watched wallets funded with ${currency} for network fees.`,
        cta,
      }
    case 'search_intent':
      return {
        eyebrow: 'Sponsored',
        title: `Looking to buy ${currency}?`,
        body: `Check the network here, then open Binance in a new tab.`,
        cta,
      }
    case 'developer':
      return {
        eyebrow: 'Sponsored',
        title: 'Testing wallet flows?',
        body: `Keep ${currency} funded while building on ${chain.name}.`,
        cta,
      }
    case 'api_docs':
      return {
        eyebrow: 'Sponsored',
        title: 'Building with live chain data?',
        body: `Fund test wallets and operational accounts with ${currency}.`,
        cta,
      }
    case 'verify':
      return {
        eyebrow: 'Sponsored',
        title: 'Deploying contracts?',
        body: `Keep ${currency} ready for deploys, retries, and maintenance transactions.`,
        cta,
      }
    case 'not_found':
      return {
        eyebrow: 'Sponsored',
        title: 'Wrong network or empty wallet?',
        body: `You can still fund ${currency} on Binance.`,
        cta,
      }
    case 'footer':
      return {
        eyebrow: 'Sponsored',
        title: `Buy ${currency} on Binance`,
        body: `A native exchange shortcut for ${chain.name} users.`,
        cta,
      }
    case 'home':
    default:
      return {
        eyebrow: 'Sponsored',
        title: `Start with ${currency}`,
        body: `Explore ${chain.name} here, then fund your wallet on Binance when you are ready to transact.`,
        cta,
      }
  }
}
