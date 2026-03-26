import { safeBigInt } from '@/lib/format'

/** Decode a transaction into a human-readable summary for EthScan. */

interface TransferInfo {
  tokenAddress: string
  fromAddress: string
  toAddress: string
  value: string
  tokenSymbol?: string
  tokenDecimals?: number
}

interface TxInput {
  hash: string
  fromAddress: string
  toAddress: string | null
  value: string
  methodId: string | null
  status: boolean | null
  methodName: string | null
}

interface DecodedTx {
  emoji: string
  summary: string
}

function formatValue(raw: string, decimals = 18): string {
  try {
    const divisor = 10n ** BigInt(decimals)
    const whole = safeBigInt(raw) / divisor
    const frac = safeBigInt(raw) % divisor
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '')
    return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString()
  } catch {
    return raw.slice(0, 10)
  }
}

function formatETHValue(weiStr: string): string {
  try {
    const wei = safeBigInt(weiStr)
    const eth = Number(wei) / 1e18
    if (eth === 0) return '0 ETH'
    if (eth < 0.0001) return `${eth.toExponential(2)} ETH`
    return `${eth.toFixed(4)} ETH`
  } catch {
    return '? ETH'
  }
}

export function decodeTx(tx: TxInput, transfers: TransferInfo[]): DecodedTx | null {
  const method = tx.methodName ?? tx.methodId ?? ''

  // Contract creation
  if (!tx.toAddress) {
    return { emoji: '📜', summary: 'Contract deployment' }
  }

  // Failed tx
  if (tx.status === false) {
    return { emoji: '❌', summary: 'Transaction failed' }
  }

  // Single ERC-20 transfer
  if (transfers.length === 1) {
    const t = transfers[0]
    const amount = formatValue(t.value, t.tokenDecimals ?? 18)
    const sym = t.tokenSymbol ?? t.tokenAddress.slice(0, 8) + '…'
    return { emoji: '💸', summary: `Transferred ${amount} ${sym}` }
  }

  // Multiple transfers = swap or complex DeFi
  if (transfers.length >= 2) {
    const first = transfers[0]
    const last = transfers[transfers.length - 1]
    const symIn = first.tokenSymbol ?? first.tokenAddress.slice(0, 6) + '…'
    const symOut = last.tokenSymbol ?? last.tokenAddress.slice(0, 6) + '…'
    const amtIn = formatValue(first.value, first.tokenDecimals ?? 18)
    const amtOut = formatValue(last.value, last.tokenDecimals ?? 18)
    return { emoji: '🔄', summary: `Swapped ${amtIn} ${symIn} → ${amtOut} ${symOut}` }
  }

  // Native ETH transfer
  const value = tx.value ?? '0'
  const hasValue = safeBigInt(value) > 0n
  if (hasValue) {
    return { emoji: '💎', summary: `Sent ${formatETHValue(value)}` }
  }

  // Method-based heuristics
  if (method.startsWith('approve(') || method.startsWith('0x095ea7b3'))
    return { emoji: '✅', summary: 'Token approval' }
  if (method.startsWith('stake') || method.startsWith('deposit'))
    return { emoji: '🏦', summary: 'Staking / Deposit' }
  if (method.startsWith('withdraw') || method.startsWith('unstake'))
    return { emoji: '💰', summary: 'Withdrawal / Unstake' }
  if (method.startsWith('claim') || method.startsWith('harvest'))
    return { emoji: '🎁', summary: 'Claim rewards' }
  if (method.startsWith('mint'))
    return { emoji: '🪙', summary: 'Mint' }
  if (method.startsWith('burn'))
    return { emoji: '🔥', summary: 'Burn' }
  if (method.startsWith('borrow'))
    return { emoji: '🏛️', summary: 'Borrow' }
  if (method.startsWith('repay'))
    return { emoji: '💳', summary: 'Repay' }
  if (method.startsWith('liquidat'))
    return { emoji: '⚡', summary: 'Liquidation' }

  // Contract interaction
  if (method) {
    const label = method.includes('(') ? method.split('(')[0] : method
    return { emoji: '⚙️', summary: `Contract call: ${label}` }
  }

  return null
}
