import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'

export const dynamic = 'force-dynamic'

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for')))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { address: raw } = await params

  if (!ADDRESS_REGEX.test(raw)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  // Normalize BEFORE querying — every address column in packages/db/schema.ts
  // stores lowercase, and contracts.address is a lowercased primary key.
  const address = raw.toLowerCase()

  let contracts
  try {
    // Column list is explicit and deliberately excludes bytecode and
    // source_code: this route advertises "verified-contract metadata", and
    // both columns hold blobs (raw deployed bytecode / full Solidity source)
    // that don't belong in a metadata response. abi is included — it's the
    // structured, typically-small artifact that makes a verified contract
    // usable (it's what /api/v1/contracts/:address/call parses to build calls).
    contracts = await db
      .select({
        address: schema.contracts.address,
        abi: schema.contracts.abi,
        compilerVersion: schema.contracts.compilerVersion,
        verifiedAt: schema.contracts.verifiedAt,
        verifySource: schema.contracts.verifySource,
        license: schema.contracts.license,
      })
      .from(schema.contracts)
      .where(eq(schema.contracts.address, address))
      .limit(1)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (contracts.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return apiJson({ contract: contracts[0] })
}
