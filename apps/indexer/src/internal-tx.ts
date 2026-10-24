import type { JsonRpcProvider } from 'ethers'

/**
 * Internal transactions — value moved by contract code rather than by the
 * outer transaction: `call`/`callcode` frames with a non-zero value, contract
 * creations funded with value, and selfdestruct sweeps. This is what Etherscan's
 * "Internal Txns" tab lists, and it is deliberately NOT the full call tree:
 * measured 2026-09-03 the full tree is 5.7× (ETH) / 8.3× (BSC) the size of
 * token_transfers, which would not fit on either database. Value-bearing frames
 * are ~0.87× (ETH) / ~0.23× (BSC).
 *
 * Source: geth-style `debug_traceBlockByNumber` with the built-in `callTracer`.
 * Every provider that traces at all serves this shape (verified on drpc for both
 * chains); Parity-style `trace_block` was NOT available on BSC.
 */

/** One frame of a callTracer tree. Only the fields the decoder reads are typed. */
export type RawTraceFrame = {
  type?: string
  from?: string
  to?: string
  value?: string
  error?: string
  calls?: RawTraceFrame[]
}

/** One element of the `debug_traceBlockByNumber` result array. */
export type RawTraceTx = {
  txHash: string
  result?: RawTraceFrame
  /** Some nodes report a per-transaction tracing failure here instead of throwing. */
  error?: string
}

export type InternalTxCallType = 'call' | 'callcode' | 'create' | 'create2' | 'selfdestruct'

export type InternalTxRow = {
  txHash: string
  /** Dotted path of child indices from the outer call, e.g. `'0'`, `'0.0.0'`. */
  traceAddress: string
  fromAddress: string
  /** Null only for a create whose address the node did not report. */
  toAddress: string | null
  /** Wei, as a decimal string — NUMERIC(78,0) on the way in. */
  value: string
  callType: InternalTxCallType
  blockNumber: number
  timestamp: Date
}

// DELEGATECALL and STATICCALL are excluded on purpose. callTracer stamps a
// delegatecall frame with the CALLER's value (it runs in the caller's context),
// so it looks funded while moving nothing — counting it double-reports every
// value that passes through a proxy.
const VALUE_MOVING: Record<string, InternalTxCallType> = {
  CALL: 'call',
  CALLCODE: 'callcode',
  CREATE: 'create',
  CREATE2: 'create2',
  SELFDESTRUCT: 'selfdestruct',
}

/** Pure. Walks every transaction's call tree and keeps the value-moving frames. */
export function decodeCallTracerBlock(
  raw: readonly RawTraceTx[],
  blockNumber: number,
  timestamp: Date,
): InternalTxRow[] {
  const rows: InternalTxRow[] = []
  for (const tx of raw) {
    const root = tx.result
    // A reverted outer transaction moved nothing, whatever its subtree says.
    if (!root || root.error) continue
    const txHash = tx.txHash.toLowerCase()
    const walk = (frame: RawTraceFrame, path: number[]) => {
      const children = frame.calls ?? []
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        // A reverted frame's whole subtree is rolled back: skip it AND its descendants.
        if (child.error) continue
        const callType = VALUE_MOVING[child.type ?? '']
        const value = child.value ? BigInt(child.value) : 0n
        const childPath = [...path, i]
        if (callType && value > 0n && child.from) {
          rows.push({
            txHash,
            traceAddress: childPath.join('.'),
            fromAddress: child.from.toLowerCase(),
            toAddress: child.to ? child.to.toLowerCase() : null,
            value: value.toString(),
            callType,
            blockNumber,
            timestamp,
          })
        }
        walk(child, childPath)
      }
    }
    walk(root, [])
  }
  return rows
}

/**
 * Pure and NEVER throws: decode a block's traces into rows, keeping only the
 * entries that belong to the block.
 *
 * Two things the bare decoder does not do, both fatal where processBlock used to
 * call it (after the first write, outside any try/catch):
 *
 *  - It trusts `txHash`. The trace endpoint is a second provider outside the
 *    failover pool, so a stale or misrouted answer would have stored another
 *    block's frames under this block's number. Entries whose hash is not one of
 *    the block's own transactions are dropped (a wholly foreign answer therefore
 *    decodes to nothing), as are entries with no usable `txHash`.
 *  - It throws on a malformed frame (`BigInt('zz')`, a null entry). Past the first
 *    write that pinned the cursor and blocked quarantine, over a secondary table.
 *    A decode failure now yields no rows plus the error for the caller to report.
 *
 * Call it ABOVE the first write so even a bug here cannot half-persist a block.
 */
export function prepareInternalTxRows(
  raw: readonly RawTraceTx[],
  blockNumber: number,
  timestamp: Date,
  blockTxHashes: readonly string[],
): { rows: InternalTxRow[]; dropped: number; problem: unknown | null } {
  try {
    const own = new Set(blockTxHashes.map(h => h.toLowerCase()))
    const kept = raw.filter(t => typeof t?.txHash === 'string' && own.has(t.txHash.toLowerCase()))
    return {
      rows: decodeCallTracerBlock(kept, blockNumber, timestamp),
      dropped: raw.length - kept.length,
      problem: null,
    }
  } catch (err) {
    return { rows: [], dropped: 0, problem: err }
  }
}

/**
 * Trace one block. Belongs in processBlock's PURE-READ phase, above the first
 * write, so a failure here can only ever abandon reads.
 *
 * A null response is NOT an empty block — see fetchBlockReceipts for the incident
 * that lesson comes from. Throwing is the only answer that cannot persist a
 * block that looks complete and is not.
 */
export async function fetchBlockTraces(provider: JsonRpcProvider, blockNumber: number): Promise<RawTraceTx[]> {
  const blockHex = '0x' + blockNumber.toString(16)
  const raw = await provider.send('debug_traceBlockByNumber', [blockHex, { tracer: 'callTracer' }]) as RawTraceTx[] | null
  if (raw === null || raw === undefined) {
    throw new Error(`Block ${blockNumber} traces unavailable (null response)`)
  }
  return raw
}
