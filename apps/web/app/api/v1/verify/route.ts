import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkRateLimit } from '@/lib/api-rate-limit'
import { triggerSourcifyVerification } from '@/lib/verifier'

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  let body: { address?: string; compilerVersion?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { address, compilerVersion = '' } = body

  if (!address || !ADDRESS_REGEX.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const result = await triggerSourcifyVerification(address, compilerVersion)

  if (result.success) {
    await db
      .insert(schema.contracts)
      .values({
        address,
        bytecode: '0x',
        verifySource: 'sourcify',
        verifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.contracts.address,
        set: {
          verifySource: 'sourcify',
          verifiedAt: new Date(),
        },
      })

    return NextResponse.json({ success: true, match: 'sourcify' }, { status: 200 })
  }

  return NextResponse.json({ success: false, error: result.error }, { status: 200 })
}
