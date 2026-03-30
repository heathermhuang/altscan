import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { checkIpRateLimit } from '@/lib/api-rate-limit'
import { triggerSourcifyVerification } from '@/lib/verifier'

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

export async function POST(request: Request) {
  // Tighter rate limit for write operations — 10 per minute per IP
  if (!(await checkIpRateLimit(request.headers.get('x-forwarded-for'), 10))) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  // Basic bot protection — check referer comes from our site
  const referer = request.headers.get('referer') ?? ''
  const origin = request.headers.get('origin') ?? ''
  const isSameOrigin = referer.includes('bnbscan.com') || referer.includes('localhost') || origin.includes('bnbscan.com') || origin.includes('localhost')
  if (!isSameOrigin) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
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
    try {
      await db
        .insert(schema.contracts)
        .values({
          address,
          bytecode: '0x',
          verifySource: 'sourcify',
          compilerVersion: compilerVersion || null,
          verifiedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.contracts.address,
          set: {
            verifySource: 'sourcify',
            compilerVersion: compilerVersion || null,
            verifiedAt: new Date(),
          },
        })
    } catch {
      return NextResponse.json(
        { success: true, match: 'sourcify', warning: 'Verified but failed to save to local DB' },
        { status: 200 },
      )
    }

    return NextResponse.json({ success: true, match: 'sourcify' }, { status: 200 })
  }

  return NextResponse.json({ success: false, error: result.error }, { status: 422 })
}
