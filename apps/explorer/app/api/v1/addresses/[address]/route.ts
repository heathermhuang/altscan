import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { selectByAddress } from '@/lib/address-query'
import { swallow, swallowed } from '@/lib/observability'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'
import { getWebProvider } from '@/lib/rpc'
import { classifyCode, resolveContractStatusFromClass, type CodeClass } from '@/lib/contract-status'
import { codeClassCache } from '@/lib/code-cache'
import { chainConfig } from '@/lib/chain'
import { getRetentionFloor, isLocalHistoryIncomplete } from '@/lib/retention'
import { trackedTokens } from '@/lib/holdings'
import { readTrackedBalances } from '@/lib/tracked-balances'

export const dynamic = 'force-dynamic'

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

/**
 * Whether retention has cut this address's lists short. The index keeps only a
 * few days, so empty lists alone cannot tell "no activity" from "nothing
 * recent". addresses.first_seen is never pruned, so a first_seen older than the
 * retention floor means the index has dropped this address's earliest
 * transactions: the check the address page makes (lib/retention.ts). null when either
 * side is unknown, including an address the index has no row for: whatever
 * history it has, the index cannot vouch for it.
 */
async function readCoverage(address: string) {
  const [firstSeen, indexedFrom] = await Promise.all([
    db
      .select({ firstSeen: schema.addresses.firstSeen })
      .from(schema.addresses)
      .where(eq(schema.addresses.address, address))
      .limit(1)
      .then((r) => r[0]?.firstSeen ?? null)
      .catch(swallowed('api/v1/addresses/coverage', null)),
    getRetentionFloor(),
  ])
  const historyComplete = firstSeen && indexedFrom ? !isLocalHistoryIncomplete(firstSeen, indexedFrom) : null
  return { historyComplete, indexedFrom }
}

/**
 * Live balances from the chain: the native coin, and the tracked tokens (the
 * chain's stablecoins and wrapped native) that lib/tracked-balances.ts reads for
 * the address page. null = could not read, never "holds nothing".
 */
async function readBalances(address: string) {
  const tokens = trackedTokens(chainConfig.whales)
  try {
    const provider = await getWebProvider()
    const [nativeBalance, tracked] = await Promise.all([
      provider.getBalance(address).catch(swallowed('api/v1/addresses/balance', null)),
      readTrackedBalances(provider, address, tokens),
    ])
    const trackedTokenBalances = tracked
      ? tokens.map((t) => ({ tokenAddress: t.address, symbol: t.symbol, decimals: t.decimals, balance: tracked[t.address] }))
      : null
    return { nativeBalance, trackedTokenBalances }
  } catch (e) {
    swallow('api/v1/addresses/balance', e)
    return { nativeBalance: null, trackedTokenBalances: null }
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  if (!(await checkIpRateLimit(request.headers))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { address: rawAddress } = await params

  if (!ADDRESS_REGEX.test(rawAddress)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  // ⚠ Normalize BEFORE querying. The indexer stores every address lowercased
  // (block-processor lowercases from/to/token/miner) and contracts.address is a
  // lowercased primary key, but ADDRESS_REGEX accepts checksummed input. This
  // route was the one reader that did not normalize, so a checksummed request
  // silently returned empty transactions, empty transfers, AND a missed contracts
  // row — the address page has always done this at its own entry point.
  const address = rawAddress.toLowerCase()

  // Additive fields, read alongside the index queries. Neither can reject: a
  // failure degrades to null, never turns a working request into a 500.
  const coverage = readCoverage(address)
  const balances = readBalances(address)

  let transactions, tokenTransfers, contracts
  try {
    // selectByAddress, not `from = a OR to = a`: the OR form hit the 15s statement
    // timeout on the busiest addresses (a Binance hot wallet, 0x…dEaD).
    ;[transactions, tokenTransfers, contracts] = await Promise.all([
      selectByAddress(db, schema.transactions, address, [], { order: 'desc', limit: 20, offset: 0 }),
      selectByAddress(db, schema.tokenTransfers, address, [], { order: 'desc', limit: 20, offset: 0 }),
      db
        .select()
        .from(schema.contracts)
        .where(eq(schema.contracts.address, address))
        .limit(1),
    ])
  } catch (e) {
    swallow('api/v1/addresses', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // ⚠ Registry presence proves a contract; registry ABSENCE proves nothing.
  // schema.contracts is only written on a successful Sourcify verification, so
  // `contracts.length > 0` reported isContract:false for every unverified
  // contract on the chain — which is most of them. eth_getCode is the only
  // complete signal. Deliberately outside the try/catch above: an RPC blip must
  // degrade to the registry answer, never turn a working request into a 500.
  // Shares the process-wide verdict cache with the address page, so a hot
  // address costs no RPC call here at all.
  let cls: CodeClass | null = codeClassCache.get(address) ?? null
  if (cls === null) {
    try {
      const provider = await getWebProvider()
      const rawCode = await provider.getCode(address).catch(() => null)
      if (rawCode !== null) {
        cls = classifyCode(rawCode)
        if (cls !== 'malformed') codeClassCache.set(address, cls)
      }
    } catch { /* provider unavailable — fall back to the registry signal */ }
  }
  const { isContract, isContractKnown } = (() => {
    const r = resolveContractStatusFromClass({ cls, verified: contracts.length > 0 })
    return { isContract: r.isContract, isContractKnown: r.known }
  })()

  // isContract stays a boolean for v1 compatibility, but during an RPC outage a
  // bare `false` is indistinguishable from a real EOA. isContractKnown is
  // additive, so existing clients are unaffected and careful ones can tell.
  // The fields after it follow the same rule: additive, and null when unknown.
  return apiJson({ transactions, tokenTransfers, isContract, isContractKnown, ...(await coverage), ...(await balances) })
}
