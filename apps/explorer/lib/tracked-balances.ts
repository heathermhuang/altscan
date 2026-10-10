/**
 * Live balances of the tracked tokens (the chain's stablecoins and wrapped native token) for one
 * address, read from the chain in a single eth_call to Multicall3.
 *
 * WHY THE CHAIN, NOT token_balances: the indexer's per-block holder-balance writes are hard-disabled
 * (apps/indexer config `holderBalanceTrackingEnabled: false`), so `token_balances` is a frozen
 * snapshot. Measured on production BNB 2026-10-10: it holds no USDT or USDC row for the #1 USDT
 * holder (0x8894E0…, ~605M USDT on chain), and its own "top" USDT holder has 32M. A lead sentence
 * priced from it would be a confident wrong number. The chain is exact, free (the web RPC, no
 * Moralis), and one more request on a page that already makes three.
 *
 * `null` means "could not read", never "holds nothing": callers label that, they do not print a zero.
 */
import { Interface } from 'ethers'
import type { TrackedToken } from './holdings'

/** Multicall3 is deployed at this address on every chain this explorer serves (checked BSC + Ethereum). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

const iface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function balanceOf(address) view returns (uint256)',
])

/**
 * Raw balance (base units, decimal string) per lowercase token address, or null when the read
 * failed. allowFailure is false on purpose: one token that cannot answer makes the whole read
 * unknown, rather than a partial list that looks complete.
 */
export async function readTrackedBalances(
  provider: { call(tx: { to: string; data: string }): Promise<string> },
  holder: string,
  tokens: readonly TrackedToken[],
): Promise<Record<string, string> | null> {
  try {
    const balanceOf = iface.encodeFunctionData('balanceOf', [holder])
    const data = iface.encodeFunctionData('aggregate3', [tokens.map((t) => [t.address, false, balanceOf])])
    const answer = iface.decodeFunctionResult('aggregate3', await provider.call({ to: MULTICALL3, data }))[0] as [boolean, string][]
    if (answer.length !== tokens.length) return null
    const out: Record<string, string> = {}
    tokens.forEach((t, i) => {
      out[t.address] = String(iface.decodeFunctionResult('balanceOf', answer[i][1])[0])
    })
    return out
  } catch {
    return null
  }
}
