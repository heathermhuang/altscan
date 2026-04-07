export function register() {
  if (process.env.NODE_ENV === 'production') {
    // Graceful restart threshold: exit cleanly at 1.3GB heap so Render restarts
    // us without the messy SIGABRT (exit 134) that kills in-flight requests.
    // --max-old-space-size is 1536MB; we bail at ~85% to leave headroom for GC.
    const HEAP_LIMIT_MB = 1300

    setInterval(() => {
      const mem = process.memoryUsage()
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024)
      const fmt = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`
      console.log(
        `[mem] rss=${fmt(mem.rss)} heap=${fmt(mem.heapUsed)}/${fmt(mem.heapTotal)} ext=${fmt(mem.external)} arr=${fmt(mem.arrayBuffers)}`
      )
      if (heapMB > HEAP_LIMIT_MB) {
        console.warn(`[mem] Heap ${heapMB}MB exceeds ${HEAP_LIMIT_MB}MB — graceful restart`)
        process.exit(0)
      }
    }, 30_000) // Check every 30s (was 60s) for faster detection
  }
}
