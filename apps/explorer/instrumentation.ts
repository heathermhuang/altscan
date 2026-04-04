export function register() {
  if (process.env.NODE_ENV === 'production') {
    // Log memory usage every 60s so we can see what's growing before an OOM crash
    setInterval(() => {
      const mem = process.memoryUsage()
      const fmt = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`
      console.log(
        `[mem] rss=${fmt(mem.rss)} heap=${fmt(mem.heapUsed)}/${fmt(mem.heapTotal)} ext=${fmt(mem.external)} arr=${fmt(mem.arrayBuffers)}`
      )
    }, 60_000)
  }
}
