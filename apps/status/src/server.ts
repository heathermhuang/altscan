import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { html } from './page.js'

// ── Config ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3090
const ADMIN_SECRET = process.env.ADMIN_SECRET || ''
const POLL_INTERVAL = 30_000 // 30s
const HISTORY_HOURS = 24
const MAX_HISTORY = (HISTORY_HOURS * 3600_000) / POLL_INTERVAL // ~2880 entries

interface ServiceHealth {
  name: string
  url: string
  healthUrl: string
  status: 'operational' | 'degraded' | 'down' | 'unknown'
  latestBlock: number | null
  lagSeconds: number | null
  responseTimeMs: number | null
  dbSizeMB: number | null
  txRows: number | null
  blockRows: number | null
  activeConns: number | null
  totalConns: number | null
  heapUsedMB: number | null
  uptime: number | null
  lastChecked: string | null
  error: string | null
}

interface HistoryEntry {
  ts: number
  status: 'operational' | 'degraded' | 'down'
  responseTimeMs: number | null
  lagSeconds: number | null
}

// ── State ───────────────────────────────────────────────────────────
const services: Record<string, ServiceHealth> = {
  ethscan: {
    name: 'ethscan.io',
    url: 'https://ethscan.io',
    healthUrl: 'https://ethscan.io/api/health',
    status: 'unknown',
    latestBlock: null, lagSeconds: null, responseTimeMs: null,
    dbSizeMB: null, txRows: null, blockRows: null,
    activeConns: null, totalConns: null, heapUsedMB: null,
    uptime: null, lastChecked: null, error: null,
  },
  bnbscan: {
    name: 'bnbscan.com',
    url: 'https://bnbscan.com',
    healthUrl: 'https://bnbscan.com/api/health',
    status: 'unknown',
    latestBlock: null, lagSeconds: null, responseTimeMs: null,
    dbSizeMB: null, txRows: null, blockRows: null,
    activeConns: null, totalConns: null, heapUsedMB: null,
    uptime: null, lastChecked: null, error: null,
  },
}

const history: Record<string, HistoryEntry[]> = {
  ethscan: [],
  bnbscan: [],
}

// ── Polling ─────────────────────────────────────────────────────────
async function checkService(key: string) {
  const svc = services[key]
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const headers: Record<string, string> = {}
    if (ADMIN_SECRET) headers['Authorization'] = `Bearer ${ADMIN_SECRET}`

    const res = await fetch(svc.healthUrl, { signal: controller.signal, headers })
    clearTimeout(timeout)
    const elapsed = Date.now() - start

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('json')) {
      // DDoS protection page or non-JSON — treat as degraded but reachable
      svc.status = 'degraded'
      svc.responseTimeMs = elapsed
      svc.error = 'Non-JSON response (DDoS protection)'
      svc.lastChecked = new Date().toISOString()
      pushHistory(key, 'degraded', elapsed, svc.lagSeconds)
      return
    }

    const data = await res.json() as Record<string, unknown>
    svc.responseTimeMs = elapsed
    svc.lastChecked = new Date().toISOString()
    svc.error = null

    if (data.status === 'ok') {
      svc.latestBlock = (data.latestBlock as number) ?? null
      svc.lagSeconds = (data.lagSeconds as number) ?? null

      // Admin-only fields
      const db = data.database as Record<string, number> | undefined
      if (db) {
        svc.dbSizeMB = db.sizeMB ?? null
        svc.txRows = db.txRows ?? null
        svc.blockRows = db.blockRows ?? null
        svc.activeConns = db.activeConns ?? null
        svc.totalConns = db.totalConns ?? null
      }
      const mem = data.memory as Record<string, unknown> | undefined
      if (mem) svc.heapUsedMB = (mem.heapUsedMB as number) ?? null
      svc.uptime = (data.uptime as number) ?? null

      // Lag > 2 min = degraded
      svc.status = (svc.lagSeconds !== null && svc.lagSeconds > 120) ? 'degraded' : 'operational'
    } else {
      svc.status = 'degraded'
    }
    pushHistory(key, svc.status === 'operational' ? 'operational' : 'degraded', elapsed, svc.lagSeconds)
  } catch (err) {
    const elapsed = Date.now() - start
    svc.status = 'down'
    svc.responseTimeMs = elapsed
    svc.error = err instanceof Error ? err.message : 'Unknown error'
    svc.lastChecked = new Date().toISOString()
    pushHistory(key, 'down', null, null)
  }
}

function pushHistory(key: string, status: HistoryEntry['status'], responseTimeMs: number | null, lagSeconds: number | null) {
  const arr = history[key]
  arr.push({ ts: Date.now(), status, responseTimeMs, lagSeconds })
  while (arr.length > MAX_HISTORY) arr.shift()
}

async function pollAll() {
  await Promise.all(Object.keys(services).map(k => checkService(k)))
}

// ── App ─────────────────────────────────────────────────────────────
const app = new Hono()
app.use('*', cors())

app.get('/', (c) => {
  return c.html(html(services, history))
})

app.get('/api/status', (c) => {
  return c.json({ services, history, checkedAt: new Date().toISOString() })
})

// ── Start ───────────────────────────────────────────────────────────
pollAll()
setInterval(pollAll, POLL_INTERVAL)

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[status] Listening on :${PORT}`)
})
