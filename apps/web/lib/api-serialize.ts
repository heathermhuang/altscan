/**
 * Recursively converts BigInt values to strings for JSON serialization.
 * Required because Drizzle returns bigint columns (mode:'bigint') as JS BigInt,
 * which JSON.stringify cannot handle.
 */
export function serializeBigInt(obj: unknown): unknown {
  if (typeof obj === 'bigint') return obj.toString()
  if (Array.isArray(obj)) return obj.map(serializeBigInt)
  if (obj instanceof Date) return obj.toISOString()
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, serializeBigInt(v)])
    )
  }
  return obj
}

/** Drop-in replacement for NextResponse.json() that handles BigInt fields. */
export function apiJson(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(serializeBigInt(data)), {
    status: (init as { status?: number })?.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...((init as { headers?: Record<string, string> })?.headers ?? {}),
    },
  })
}
