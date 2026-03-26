import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { Contract, Interface } from 'ethers'
import { getProvider } from '@/lib/rpc'
import { authRequest } from '@/lib/api-auth'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const auth = await authRequest(request)
  if (!auth.ok) return NextResponse.json({ error: auth.reason === 'invalid_key' ? 'Invalid or inactive API key' : 'Rate limit exceeded' }, { status: auth.reason === 'invalid_key' ? 401 : 429 })

  const { address } = await params
  const addr = address.toLowerCase()

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const [contract] = await db.select().from(schema.contracts)
    .where(eq(schema.contracts.address, addr))

  if (!contract?.abi) {
    return NextResponse.json({ error: 'Contract not found or ABI not available' }, { status: 404 })
  }

  let body: { functionName: string; args?: unknown[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { functionName, args = [] } = body

  if (!functionName || typeof functionName !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionName)) {
    return NextResponse.json({ error: 'Invalid functionName' }, { status: 400 })
  }

  // Validate args: must be array, max 10 elements, max 10KB serialized (prevents DoS)
  if (!Array.isArray(args)) {
    return NextResponse.json({ error: 'args must be an array' }, { status: 400 })
  }
  if (args.length > 10) {
    return NextResponse.json({ error: 'Maximum 10 args allowed' }, { status: 400 })
  }
  if (JSON.stringify(args).length > 10240) {
    return NextResponse.json({ error: 'args payload too large (max 10KB)' }, { status: 400 })
  }

  try {
    const iface = new Interface(contract.abi as string)

    // Verify the function exists in the ABI and is a read-only (view/pure) function
    let fnFragment
    try {
      fnFragment = iface.getFunction(functionName)
    } catch {
      return NextResponse.json({ error: `Function "${functionName}" not found in contract ABI` }, { status: 400 })
    }
    if (!fnFragment) {
      return NextResponse.json({ error: `Function "${functionName}" not found in contract ABI` }, { status: 400 })
    }
    // Block state-mutating calls (only allow view/pure)
    if (fnFragment.stateMutability !== 'view' && fnFragment.stateMutability !== 'pure') {
      return NextResponse.json({ error: 'Only view and pure functions can be called' }, { status: 400 })
    }

    const ethersContract = new Contract(address, iface, getProvider())
    const result = await ethersContract[functionName](...args)
    // Serialize result (handle bigints)
    const serialized = JSON.parse(JSON.stringify(result, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    ))
    return NextResponse.json({ result: serialized })
  } catch (err) {
    // Return safe error message without internal details
    const message = err instanceof Error ? err.message.split('\n')[0] : 'Call failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
