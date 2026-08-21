import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, desc, or } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'
import { getWebProvider } from '@/lib/rpc'
import { classifyCode, resolveContractStatusFromClass, type CodeClass } from '@/lib/contract-status'
import { codeClassCache } from '@/lib/code-cache'

export const dynamic = 'force-dynamic'

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for')))) {
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

  let transactions, tokenTransfers, contracts
  try {
    ;[transactions, tokenTransfers, contracts] = await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(
          or(
            eq(schema.transactions.fromAddress, address),
            eq(schema.transactions.toAddress, address),
          ),
        )
        .orderBy(desc(schema.transactions.timestamp))
        .limit(20),
      db
        .select()
        .from(schema.tokenTransfers)
        .where(
          or(
            eq(schema.tokenTransfers.fromAddress, address),
            eq(schema.tokenTransfers.toAddress, address),
          ),
        )
        .orderBy(desc(schema.tokenTransfers.timestamp))
        .limit(20),
      db
        .select()
        .from(schema.contracts)
        .where(eq(schema.contracts.address, address))
        .limit(1),
    ])
  } catch {
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
  return apiJson({ transactions, tokenTransfers, isContract, isContractKnown })
}
