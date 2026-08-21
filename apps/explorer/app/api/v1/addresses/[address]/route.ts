import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq, desc, or } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'
import { getWebProvider } from '@/lib/rpc'
import { resolveContractStatus } from '@/lib/contract-status'

export const dynamic = 'force-dynamic'

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for')))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { address } = await params

  if (!ADDRESS_REGEX.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

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
  let code: string | null = null
  try {
    const provider = await getWebProvider()
    code = await provider.getCode(address).catch(() => null)
  } catch { /* provider unavailable — fall back to the registry signal */ }
  const { isContract, isContractKnown } = (() => {
    const r = resolveContractStatus({ code, verified: contracts.length > 0 })
    return { isContract: r.isContract, isContractKnown: r.known }
  })()

  // isContract stays a boolean for v1 compatibility, but during an RPC outage a
  // bare `false` is indistinguishable from a real EOA. isContractKnown is
  // additive, so existing clients are unaffected and careful ones can tell.
  return apiJson({ transactions, tokenTransfers, isContract, isContractKnown })
}
