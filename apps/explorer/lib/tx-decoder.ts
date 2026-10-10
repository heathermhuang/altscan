// Rule-based plain-English transaction decoder
// Turns raw tx data into human-readable descriptions

import type { ChainKey } from '@altscan/chain-config'
import { getAddressLabel } from './known-addresses'
import { safeBigInt, formatTokenAmount, sanitizeSymbolOr } from './format'
import { lookalikeOf } from './lookalike'
import { anyLinkLike } from './link-in-name'

export interface DecodedTx {
  summary: string
  type: 'transfer' | 'swap' | 'approval' | 'contract_deploy' | 'contract_call' | 'other'
}

export interface TxTransferInfo {
  tokenAddress: string
  fromAddress: string
  toAddress: string
  value: string
  tokenSymbol?: string
  tokenDecimals?: number
}

/**
 * The symbol a transfer may be NAMED by in a headline, or undefined (decodeTx then falls back to
 * the token address prefix). A token symbol is chosen by whoever deploys the contract: an
 * address-poisoning dust transfer calls itself "USDT", and a headline that says "Transferred 0
 * USDT" repeats the lie in the page's largest type. So a token that lookalikeOf flags (it reads as
 * a well-known token but is not that contract) gets no symbol, and any other symbol is sanitised
 * (control/bidi/non-ASCII stripped) and treated as missing when nothing printable survives; the
 * lookalike test runs on the sanitised text (what would be shown) as well as the raw. A symbol that
 * reads as a URL or a handle ("claim-bnb.xyz") is an advert, not a name, and gets none either. The
 * chain is a parameter: pass `chainConfig.key`.
 */
export function safeTransferSymbol(
  address: string,
  symbol: string | null | undefined,
  chain: ChainKey,
): string | undefined {
  if (!symbol) return undefined
  // Sanitise FIRST and judge what the page would show. foldConfusables keeps characters that
  // sanitizeSymbol strips (any non-ASCII character the glyph table has no entry for), so "US<euro>DT" does
  // not fold to USDT yet displays as USDT. The raw symbol is checked too: it catches the shapes only the
  // fold sees (invisible and lookalike letters that sanitising keeps or maps differently).
  const clean = sanitizeSymbolOr(symbol, '')
  if (!clean) return undefined
  if (lookalikeOf({ address, symbol: clean }, chain) || lookalikeOf({ address, symbol }, chain)) return undefined
  if (anyLinkLike(clean, symbol)) return undefined
  return clean
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
}, transfers: TxTransferInfo[], nativeCurrency = 'BNB'): DecodedTx {
  // Contract deployment
  if (!tx.toAddress) {
    return { summary: 'Deployed a new smart contract', type: 'contract_deploy' }
  }

  const nativeValue = Number(safeBigInt(tx.value)) / 1e18
  const toLabel = getAddressLabel(tx.toAddress) ?? null

  // Simple native-token transfer (no input data or 0x method)
  if (!tx.methodId || tx.methodId === '0x') {
    if (nativeValue > 0) {
      const to = toLabel ?? `${tx.toAddress.slice(0, 12)}…`
      // Avoid scientific notation for very small values
      let nativeStr: string
      if (nativeValue >= 0.0001) {
        nativeStr = nativeValue.toFixed(4)
      } else {
        // Show enough decimals to display significant digits
        const weiStr = safeBigInt(tx.value).toString()
        const decimals = Math.max(18 - weiStr.length + 2, 4)
        nativeStr = nativeValue.toFixed(Math.min(decimals, 18))
      }
      return {
        summary: `Sent ${nativeStr} ${nativeCurrency} to ${to}`,
        type: 'transfer',
      }
    }
    return { summary: 'Contract interaction (no data)', type: 'other' }
  }

  const methodType = METHOD_TYPES[tx.methodId] ?? tx.methodName ?? null

  // Token approval
  if (tx.methodId === '0x095ea7b3') {
    const spenderLabel = toLabel ?? `${tx.toAddress.slice(0, 12)}…`
    return { summary: `Approved ${spenderLabel} to spend tokens`, type: 'approval' }
  }

  // Swap detection.
  //
  // A swap means ONE party both gives and receives: the initiator sends token A
  // and gets token B back. The old rule was "2 or more transfers means a swap",
  // described by its FIRST and LAST leg — which labelled a Coinbase batch
  // disbursement of 18 tokens to 18 different recipients as
  // "Swapped 4280.00 USDC for 92801.40 TRAC on a DEX". Pinned by
  // tx-decoder.test.ts. An invented summary is worse than a vague one.
  const actor = tx.fromAddress.toLowerCase()
  const sent = transfers.filter((t) => t.fromAddress.toLowerCase() === actor)
  const received = transfers.filter((t) => t.toAddress.toLowerCase() === actor)
  const isSwapShape =
    sent.length > 0 &&
    received.length > 0 &&
    sent[0].tokenAddress.toLowerCase() !== received[0].tokenAddress.toLowerCase()
  // A swap routed in native currency has only one token leg, so the method name
  // stays authoritative where the transfer shape cannot see it.
  const isSwapMethod = !!(methodType && methodType.toLowerCase().includes('swap'))

  if (isSwapShape || isSwapMethod) {
    const dexLabel = toLabel ?? 'a DEX'
    if (isSwapShape) {
      const inLeg = sent[0]
      const outLeg = received[0]
      const inSym = inLeg.tokenSymbol ?? inLeg.tokenAddress.slice(0, 8)
      const outSym = outLeg.tokenSymbol ?? outLeg.tokenAddress.slice(0, 8)
      const inAmt = inLeg.tokenDecimals != null ? formatTokenAmount(inLeg.value ?? '0', inLeg.tokenDecimals, 6) : '?'
      const outAmt = outLeg.tokenDecimals != null ? formatTokenAmount(outLeg.value ?? '0', outLeg.tokenDecimals, 6) : '?'
      return {
        summary: `Swapped ${inAmt} ${inSym} for ${outAmt} ${outSym} on ${dexLabel}`,
        type: 'swap',
      }
    }
    return { summary: `Swapped tokens on ${dexLabel}`, type: 'swap' }
  }

  // Many transfers that are not a swap: state what is actually observable
  // rather than guessing at intent.
  if (transfers.length > 1) {
    const recipients = new Set(transfers.map((t) => t.toAddress.toLowerCase())).size
    const symbols = new Set(transfers.map((t) => t.tokenSymbol).filter(Boolean))
    const what = symbols.size === 1 ? ` of ${[...symbols][0]}` : ''
    return {
      summary: `${transfers.length} token transfers${what} to ${recipients} recipient${recipients === 1 ? '' : 's'}`,
      type: 'transfer',
    }
  }

  // Single token transfer
  if (tx.methodId === '0xa9059cbb' || tx.methodId === '0x23b872dd') {
    if (transfers.length > 0) {
      const t = transfers[0]
      const sym = t.tokenSymbol ?? t.tokenAddress.slice(0, 8)
      const amt = t.tokenDecimals != null ? formatTokenAmount(t.value ?? '0', t.tokenDecimals, 6) : '?'
      const to = getAddressLabel(t.toAddress) ?? `${t.toAddress.slice(0, 12)}…`
      return { summary: `Transferred ${amt} ${sym} to ${to}`, type: 'transfer' }
    }
  }

  // Generic contract call
  const contract = toLabel ?? `${tx.toAddress.slice(0, 12)}…`
  const method = methodType ? ` — ${methodType}` : ''
  return {
    summary: `Called ${contract}${method}`,
    type: 'contract_call',
  }
}

// The outcome verbs decodeTx opens its summaries with: the infinitive a failed tx "tried to" do, and the
// present participle a pending one is doing.
const OUTCOME_VERBS: Record<string, { base: string; ing: string }> = {
  Sent: { base: 'send', ing: 'Sending' },
  Swapped: { base: 'swap', ing: 'Swapping' },
  Approved: { base: 'approve', ing: 'Approving' },
  Transferred: { base: 'transfer', ing: 'Transferring' },
  Called: { base: 'call', ing: 'Calling' },
  Deployed: { base: 'deploy', ing: 'Deploying' },
}

/**
 * A failed tx's summary. decodeTx words every summary as an outcome ("Swapped tokens on X"), which a
 * failed tx did not do: "Tried to swap tokens on X". A summary that does not open with one of those
 * verbs ("3 token transfers to 2 recipients") gets a "Failed: " prefix instead.
 */
export function attemptedSummary(summary: string): string {
  const sp = summary.indexOf(' ')
  const verb = OUTCOME_VERBS[sp === -1 ? summary : summary.slice(0, sp)]
  if (!verb) return `Failed: ${summary}`
  return sp === -1 ? `Tried to ${verb.base}` : `Tried to ${verb.base}${summary.slice(sp)}`
}

/**
 * A pending tx's summary (no receipt yet, so nothing has happened): "Swapped tokens on X" reads
 * "Swapping tokens on X". A summary that does not open with an outcome verb gets a "Pending: " prefix.
 */
export function pendingSummary(summary: string): string {
  const sp = summary.indexOf(' ')
  const verb = OUTCOME_VERBS[sp === -1 ? summary : summary.slice(0, sp)]
  if (!verb) return `Pending: ${summary}`
  return sp === -1 ? verb.ing : `${verb.ing}${summary.slice(sp)}`
}
