import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { Contract, Interface } from 'ethers'
import { getWebProvider } from '@/lib/rpc'
import { authFailure, authRequest } from '@/lib/api-auth'
import { swallow } from '@/lib/observability'
import { redactSecrets } from '@/lib/redact'

// Errors about the call itself (a revert, bad arguments, undecodable return data).
// Their `shortMessage` is the reason alone. Transport errors (SERVER_ERROR,
// TIMEOUT, NETWORK_ERROR, ...) are never shown: ethers 6.17 appends
// `info={"requestUrl": ...}` to their message, and the web RPC URL is often keyed.
const CALL_ERROR_CODES: readonly string[] = [
  'CALL_EXCEPTION', 'INVALID_ARGUMENT', 'MISSING_ARGUMENT', 'UNEXPECTED_ARGUMENT',
  'BAD_DATA', 'NUMERIC_FAULT', 'BUFFER_OVERRUN',
]

export async function POST(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const auth = await authRequest(request)
  if (!auth.ok) return authFailure(auth)

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

    const ethersContract = new Contract(address, iface, await getWebProvider())
    const result = await ethersContract[functionName](...args)
    // Serialize result (handle bigints)
    const serialized = JSON.parse(JSON.stringify(result, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    ))
    return NextResponse.json({ result: serialized })
  } catch (err) {
    // Log the cause (redacted by swallow), return only a message that cannot carry the RPC URL
    swallow('api/contracts/call', err)
    const { code, shortMessage } = (err ?? {}) as { code?: unknown; shortMessage?: unknown }
    if (typeof code === 'string' && CALL_ERROR_CODES.includes(code) && typeof shortMessage === 'string') {
      return NextResponse.json({ error: redactSecrets(shortMessage) }, { status: 400 })
    }
    // Any other coded error is the transport or the node: say so, and nothing more.
    if (typeof code === 'string') {
      return NextResponse.json({ error: 'Upstream RPC error' }, { status: 502 })
    }
    return NextResponse.json({ error: 'Call failed' }, { status: 400 })
  }
}
