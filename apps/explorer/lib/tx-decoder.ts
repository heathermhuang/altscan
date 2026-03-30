// Rule-based plain-English transaction decoder
// Turns raw tx data into human-readable descriptions

import { getAddressLabel } from './known-addresses'
import { safeBigInt } from './format'

export interface DecodedTx {
  summary: string
  type: 'transfer' | 'swap' | 'approval' | 'contract_deploy' | 'contract_call' | 'other'
  emoji: string
}

export interface TxTransferInfo {
  tokenAddress: string
  fromAddress: string
  toAddress: string
  value: string
  tokenSymbol?: string
  tokenDecimals?: number
}

// Known method IDs
const METHOD_TYPES: Record<string, string> = {
  '0xa9059cbb': 'Transfer',
  '0x23b872dd': 'Transfer From',
  '0x095ea7b3': 'Approve',
  '0x38ed1739': 'Swap Exact Tokens',
  '0x8803dbee': 'Swap Tokens',
  '0x7ff36ab5': 'Swap Exact ETH',
  '0x4a25d94a': 'Swap Tokens For ETH',
  '0x18cbafe5': 'Swap Exact Tokens For ETH',
  '0xfb3bdb41': 'Swap ETH For Exact Tokens',
  '0xe8e33700': 'Add Liquidity',
  '0xbaa2abde': 'Remove Liquidity',
  '0x2e1a7d4d': 'Withdraw',
  '0xd0e30db0': 'Deposit',
  '0xa0712d68': 'Mint',
  '0x42966c68': 'Burn',
}

export function decodeTx(tx: {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string
  methodId: string | null
  status: boolean
  methodName?: string | null
}, transfers: TxTransferInfo[]): DecodedTx {
  // Contract deployment
  if (!tx.toAddress) {
    return { summary: 'Deployed a new smart contract', type: 'contract_deploy', emoji: '🏗️' }
  }

  const bnbValue = Number(safeBigInt(tx.value)) / 1e18
  const toLabel = getAddressLabel(tx.toAddress) ?? null

  // Simple BNB transfer (no input data or 0x method)
  if (!tx.methodId || tx.methodId === '0x') {
    if (bnbValue > 0) {
      const to = toLabel ?? `${tx.toAddress.slice(0, 12)}…`
      // Avoid scientific notation for very small values
      let bnbStr: string
      if (bnbValue >= 0.0001) {
        bnbStr = bnbValue.toFixed(4)
      } else {
        // Show enough decimals to display significant digits
        const weiStr = safeBigInt(tx.value).toString()
        const decimals = Math.max(18 - weiStr.length + 2, 4)
        bnbStr = bnbValue.toFixed(Math.min(decimals, 18))
      }
      return {
        summary: `Sent ${bnbStr} BNB to ${to}`,
        type: 'transfer',
        emoji: '💸',
      }
    }
    return { summary: 'Contract interaction (no data)', type: 'other', emoji: '📋' }
  }

  const methodType = METHOD_TYPES[tx.methodId] ?? tx.methodName ?? null

  // Token approval
  if (tx.methodId === '0x095ea7b3') {
    const spenderLabel = toLabel ?? `${tx.toAddress.slice(0, 12)}…`
    return { summary: `Approved ${spenderLabel} to spend tokens`, type: 'approval', emoji: '✅' }
  }

  // Swap detection — check transfers
  if (transfers.length >= 2 || (methodType && methodType.toLowerCase().includes('swap'))) {
    const dexLabel = toLabel ?? 'a DEX'
    if (transfers.length >= 2) {
      const firstToken = transfers[0]
      const lastToken = transfers[transfers.length - 1]
      const inSym = firstToken.tokenSymbol ?? firstToken.tokenAddress.slice(0, 8)
      const outSym = lastToken.tokenSymbol ?? lastToken.tokenAddress.slice(0, 8)
      const inAmt = firstToken.tokenDecimals
        ? (Number(BigInt(firstToken.value ?? '0')) / Math.pow(10, firstToken.tokenDecimals)).toFixed(2)
        : '?'
      const outAmt = lastToken.tokenDecimals
        ? (Number(BigInt(lastToken.value ?? '0')) / Math.pow(10, lastToken.tokenDecimals)).toFixed(2)
        : '?'
      return {
        summary: `Swapped ${inAmt} ${inSym} for ${outAmt} ${outSym} on ${dexLabel}`,
        type: 'swap',
        emoji: '🔄',
      }
    }
    return { summary: `Swapped tokens on ${dexLabel}`, type: 'swap', emoji: '🔄' }
  }

  // Single token transfer
  if (tx.methodId === '0xa9059cbb' || tx.methodId === '0x23b872dd') {
    if (transfers.length > 0) {
      const t = transfers[0]
      const sym = t.tokenSymbol ?? t.tokenAddress.slice(0, 8)
      const amt = t.tokenDecimals
        ? (Number(BigInt(t.value ?? '0')) / Math.pow(10, t.tokenDecimals)).toFixed(2)
        : '?'
      const to = getAddressLabel(t.toAddress) ?? `${t.toAddress.slice(0, 12)}…`
      return { summary: `Transferred ${amt} ${sym} to ${to}`, type: 'transfer', emoji: '💱' }
    }
  }

  // Generic contract call
  const contract = toLabel ?? `${tx.toAddress.slice(0, 12)}…`
  const method = methodType ? ` — ${methodType}` : ''
  return {
    summary: `Called ${contract}${method}`,
    type: 'contract_call',
    emoji: '📝',
  }
}
