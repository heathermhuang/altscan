export function register() {
  if (process.env.NODE_ENV === 'production') {
    // Graceful restart threshold: exit cleanly before V8 SIGABRT (exit 134).
    // --max-old-space-size is 1536MB; we bail at ~80% to leave headroom for GC.
    const HEAP_LIMIT_MB = 1200       // reduced from 1300 — bail earlier to avoid SIGABRT
    const HEAP_WARN_MB = 900         // warn threshold — log cache sizes for diagnostics
    const CHECK_INTERVAL_MS = 15_000 // check every 15s (was 30s) for faster detection

    // Track heap trend — detect sustained growth even below threshold
    let prevHeapMB = 0
    let growthStreak = 0             // consecutive checks where heap grew
    const GROWTH_STREAK_LIMIT = 6    // 6 × 15s = 90s of sustained growth → force GC hint

    setInterval(() => {
      const mem = process.memoryUsage()
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024)
      const fmt = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`

      // Track growth trend
      if (heapMB > prevHeapMB + 5) {
        growthStreak++
      } else {
        growthStreak = 0
      }
      prevHeapMB = heapMB

      // Normal log every check
      console.log(
        `[mem] rss=${fmt(mem.rss)} heap=${fmt(mem.heapUsed)}/${fmt(mem.heapTotal)} ext=${fmt(mem.external)} arr=${fmt(mem.arrayBuffers)} trend=${growthStreak > 0 ? `+${growthStreak}` : 'stable'}`
      )

      // Warning threshold — log extra diagnostics
      if (heapMB > HEAP_WARN_MB) {
        console.warn(`[mem] WARNING: heap ${heapMB}MB above ${HEAP_WARN_MB}MB warning threshold`)
        // Lazy-import to avoid loading cache-registry at startup
        import('./lib/cache-registry').then(({ getCacheSizes }) => {
          const sizes = getCacheSizes()
          console.warn(`[mem] Cache sizes: ${JSON.stringify(sizes)}`)
        }).catch(() => { /* ignore */ })
      }

      // Sustained growth detection — try to trigger GC before hard limit
      if (growthStreak >= GROWTH_STREAK_LIMIT && heapMB > HEAP_WARN_MB) {
        console.warn(`[mem] Sustained heap growth for ${growthStreak * CHECK_INTERVAL_MS / 1000}s at ${heapMB}MB — attempting GC`)
        if (global.gc) {
          global.gc()
          growthStreak = 0
        }
      }

      // Hard limit — graceful exit before SIGABRT
      if (heapMB > HEAP_LIMIT_MB) {
        console.error(`[mem] CRITICAL: heap ${heapMB}MB exceeds ${HEAP_LIMIT_MB}MB — graceful restart to avoid SIGABRT`)
        import('./lib/cache-registry').then(({ getCacheSizes }) => {
          console.error(`[mem] Final cache sizes: ${JSON.stringify(getCacheSizes())}`)
        }).catch(() => { /* ignore */ }).finally(() => {
          process.exit(0)
        })
        // Safety: exit even if import fails after 1s
        setTimeout(() => process.exit(0), 1000).unref()
      }
    }, CHECK_INTERVAL_MS)
  }
}
