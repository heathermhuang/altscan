/**
 * Decode ERC-20 Transfer events out of a receipt's logs.
 *
 * Needed because a transaction outside our retention window is served from RPC,
 * where there are no `token_transfers` rows to read. Without this, a tx that
 * moved 18 token balances rendered as a bare "Success" with no visible effect
 * at all — the logs were fetched and discarded.
 */

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export type TransferLogLike = {
  address: string
  topic0: string | null
  topic1: string | null
  topic2: string | null
  topic3: string | null
  data: string | null
}

export type DecodedTransfer = {
  tokenAddress: string
  fromAddress: string
  toAddress: string
  /** Raw base-unit amount as a decimal string — decimals are applied at render. */
  value: string
}

/** A 32-byte topic holds a left-padded address in its low 20 bytes. */
function addressFromTopic(topic: string | null): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null
  return `0x${topic.slice(26).toLowerCase()}`
}

export type DecodedNftTransfer = {
  tokenAddress: string
  fromAddress: string
  toAddress: string
  /** The indexed tokenId, as a decimal string. */
  tokenId: string
}

/**
 * ERC-721 transfers from the same logs.
 *
 * These share topic0 with ERC-20 but index `tokenId` as a 4th topic, so
 * decodeTransferLogs deliberately skips them — rendering one as fungible would
 * print a tokenId where an amount belongs. Skipping them entirely made NFT
 * movement invisible on the RPC path, so they are decoded separately here.
 */
export function decodeNftTransferLogs(logs: TransferLogLike[]): DecodedNftTransfer[] {
  const out: DecodedNftTransfer[] = []
  for (const log of logs) {
    if (log.topic0?.toLowerCase() !== TRANSFER_TOPIC0) continue
    if (!log.topic3) continue   // 3 topics = fungible, handled above

    const fromAddress = addressFromTopic(log.topic1)
    const toAddress = addressFromTopic(log.topic2)
    if (!fromAddress || !toAddress) continue
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.topic3)) continue

    let tokenId: string
    try {
      tokenId = BigInt(log.topic3).toString()
    } catch {
      continue
    }
    out.push({ tokenAddress: log.address.toLowerCase(), fromAddress, toAddress, tokenId })
  }
  return out
}

export function decodeTransferLogs(logs: TransferLogLike[]): DecodedTransfer[] {
  const out: DecodedTransfer[] = []
  for (const log of logs) {
    if (log.topic0?.toLowerCase() !== TRANSFER_TOPIC0) continue
    // ERC-721 reuses this topic0 but indexes tokenId as a 4th topic, leaving
    // `data` empty. Rendering one as fungible would print a tokenId in the
    // amount column, so non-fungible transfers are excluded here.
    if (log.topic3) continue

    const fromAddress = addressFromTopic(log.topic1)
    const toAddress = addressFromTopic(log.topic2)
    if (!fromAddress || !toAddress) continue

    const hex = (log.data ?? '').replace(/^0x/, '')
    // Only the first word is the value; some tokens append extra data.
    const word = hex.slice(0, 64)
    if (word.length !== 64 || !/^[0-9a-fA-F]+$/.test(word)) continue

    let value: string
    try {
      value = BigInt(`0x${word}`).toString()
    } catch {
      continue
    }

    out.push({ tokenAddress: log.address.toLowerCase(), fromAddress, toAddress, value })
  }
  return out
}
