import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { apiJson } from '@/lib/api-serialize'
import { chainConfig } from '@/lib/chain'
import { lookalikeOf } from '@/lib/lookalike'

export const dynamic = 'force-dynamic'

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  if (!(await checkIpRateLimit(request.headers))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  const { address: raw } = await params

  if (!ADDRESS_REGEX.test(raw)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  // Normalize BEFORE querying — every address column in packages/db/schema.ts
  // stores lowercase, and tokens.address is a lowercased primary key.
  const address = raw.toLowerCase()

  let tokens
  try {
    tokens = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.address, address))
      .limit(1)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (tokens.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Evidence, not a verdict: a name or symbol that reads as a well-known token on another contract.
  // null means no match against that short list, never "safe".
  return apiJson({ token: tokens[0], lookalike: lookalikeOf(tokens[0], chainConfig.key) })
}
