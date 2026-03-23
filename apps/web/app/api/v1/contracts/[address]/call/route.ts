import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { Contract, Interface } from 'ethers'
import { getProvider } from '@/lib/rpc'
import { checkRateLimit } from '@/lib/api-rate-limit'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const { address } = await params
  const addr = address.toLowerCase()

  const [contract] = await db.select().from(schema.contracts)
    .where(eq(schema.contracts.address, addr))

  if (!contract?.abi) {
    return NextResponse.json({ error: 'Contract not found or ABI not available' }, { status: 404 })
  }

  const { functionName, args = [] } = await request.json() as { functionName: string; args: unknown[] }

  try {
    const iface = new Interface(contract.abi as string)
    const ethersContract = new Contract(address, iface, getProvider())
    const result = await ethersContract[functionName](...args)
    // Serialize result (handle bigints)
    const serialized = JSON.parse(JSON.stringify(result, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    ))
    return NextResponse.json({ result: serialized })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 })
  }
}
