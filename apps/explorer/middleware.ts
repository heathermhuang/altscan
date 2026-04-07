import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Minimal middleware — placeholder for future request-level logic.
 *
 * NOTE: Next.js middleware runs in Edge Runtime. process.memoryUsage() and
 * other Node.js APIs are NOT available here. All memory monitoring is handled
 * by instrumentation.ts which runs in the Node.js server process.
 */
export function middleware(_request: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
