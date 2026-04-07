import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Memory-pressure middleware — shed load before V8 SIGABRT.
 *
 * When heap usage exceeds the danger threshold, new page requests get a
 * 503 with Retry-After so Render's health check still passes (/api/ping
 * is excluded) but we stop accepting new work that would push us over.
 *
 * This catches the gap between the 15s instrumentation check and a sudden
 * spike — middleware runs on every request so it's checked much more frequently.
 */

const HEAP_SHED_MB = 900 // start shedding load at 900MB (before 1000MB graceful exit)

export function middleware(request: NextRequest) {
  const mem = process.memoryUsage()
  const heapMB = mem.heapUsed / 1024 / 1024

  if (heapMB > HEAP_SHED_MB) {
    const path = request.nextUrl.pathname

    // Always allow health check and ping so Render doesn't mark us as dead
    if (path === '/api/ping' || path === '/api/health') {
      return NextResponse.next()
    }

    // Allow static assets and _next paths
    if (path.startsWith('/_next/') || path.startsWith('/favicon')) {
      return NextResponse.next()
    }

    console.warn(
      `[mem-shed] Rejecting ${request.method} ${path} — heap ${Math.round(heapMB)}MB exceeds ${HEAP_SHED_MB}MB`
    )

    return new NextResponse(
      'Service temporarily unavailable — memory pressure. Retrying shortly.',
      {
        status: 503,
        headers: {
          'Retry-After': '10',
          'Cache-Control': 'no-store',
        },
      }
    )
  }

  return NextResponse.next()
}

export const config = {
  // Run on all routes except static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
