const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

const MAX_REQUESTS = 100
const WINDOW_MS = 60 * 1000 // 60 seconds

export function checkRateLimit(ip: string): boolean {
  const clientIp = ip.split(',')[0].trim()
  const now = Date.now()
  const entry = rateLimitMap.get(clientIp)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.delete(clientIp)
    rateLimitMap.set(clientIp, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }

  if (entry.count >= MAX_REQUESTS) {
    return false
  }

  entry.count++
  return true
}
