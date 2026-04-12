interface ServiceHealth {
  name: string
  url: string
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

interface DailySummary {
  date: string
  total: number
  operational: number
  degraded: number
  down: number
}

function statusColor(s: string) {
  if (s === 'operational') return '#10b981'
  if (s === 'degraded') return '#f59e0b'
  if (s === 'down') return '#ef4444'
  return '#6b7280'
}

function statusLabel(s: string) {
  if (s === 'operational') return 'Operational'
  if (s === 'degraded') return 'Degraded'
  if (s === 'down') return 'Down'
  return 'Checking...'
}

function renderDailyTimeline(entries: DailySummary[]): { bars: string; uptimePercent: string } {
  const DAYS = 30
  const now = new Date()
  const bars: string[] = []
  let totalChecks = 0
  let totalOp = 0

  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    const entry = entries.find(e => e.date === dateStr)

    let color = '#374151'
    let title = `${dateStr}: No data`
    if (entry && entry.total > 0) {
      const pct = ((entry.operational / entry.total) * 100).toFixed(1)
      if (entry.down > 0) color = '#ef4444'
      else if (entry.degraded > 0) color = '#f59e0b'
      else color = '#10b981'
      title = `${dateStr}: ${pct}% uptime`
      totalChecks += entry.total
      totalOp += entry.operational
    }

    bars.push(`<div class="bar daily-bar" style="background:${color}" title="${title}"></div>`)
  }

  const uptimePercent = totalChecks > 0 ? ((totalOp / totalChecks) * 100).toFixed(2) : '—'
  return { bars: bars.join(''), uptimePercent }
}

function formatNumber(n: number | null): string {
  if (n === null || n < 0) return '—'
  return n.toLocaleString('en-US')
}

function formatLag(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function overallStatus(services: Record<string, ServiceHealth>): { label: string; color: string; bg: string } {
  const statuses = Object.values(services).map(s => s.status)
  if (statuses.some(s => s === 'down')) return { label: 'Partial Outage', color: '#ef4444', bg: '#451a1a' }
  if (statuses.some(s => s === 'degraded')) return { label: 'Degraded Performance', color: '#f59e0b', bg: '#452a1a' }
  if (statuses.every(s => s === 'operational')) return { label: 'All Systems Operational', color: '#10b981', bg: '#1a2e24' }
  return { label: 'Checking Systems...', color: '#6b7280', bg: '#1f2937' }
}

function renderTimeline(entries: HistoryEntry[]): { bars: string; rangeLabel: string } {
  const BARS = 90
  const now = Date.now()

  // Adaptive range: use time since first entry, minimum 10 min, max 24h
  const oldest = entries.length > 0 ? entries[0].ts : now
  const spanMs = Math.min(Math.max(now - oldest, 45 * 60_000), 24 * 3600_000)
  const bucketMs = spanMs / BARS
  const bars: string[] = []

  for (let i = 0; i < BARS; i++) {
    const bucketStart = now - (BARS - i) * bucketMs
    const bucketEnd = bucketStart + bucketMs
    const inBucket = entries.filter(e => e.ts >= bucketStart && e.ts < bucketEnd)

    let color = '#374151' // no data
    if (inBucket.length > 0) {
      if (inBucket.some(e => e.status === 'down')) color = '#ef4444'
      else if (inBucket.some(e => e.status === 'degraded')) color = '#f59e0b'
      else color = '#10b981'
    }
    bars.push(`<div class="bar" style="background:${color}" title="${new Date(bucketStart).toLocaleTimeString()}"></div>`)
  }

  // Human-readable range label
  const spanMin = Math.round(spanMs / 60_000)
  let rangeLabel: string
  if (spanMin < 60) rangeLabel = `${spanMin}m ago`
  else if (spanMin < 1440) rangeLabel = `${Math.round(spanMin / 60)}h ago`
  else rangeLabel = '24h ago'

  return { bars: bars.join(''), rangeLabel }
}

function serviceCard(key: string, svc: ServiceHealth, hist: HistoryEntry[], dailyHist: DailySummary[]): string {
  const color = statusColor(svc.status)
  const label = statusLabel(svc.status)
  const uptimePercent = hist.length > 0
    ? ((hist.filter(e => e.status === 'operational').length / hist.length) * 100).toFixed(2)
    : '—'

  return `
    <div class="card">
      <div class="card-header">
        <div class="service-info">
          <div class="status-dot" style="background:${color}"></div>
          <div>
            <h2 class="service-name"><a href="${svc.url}" target="_blank">${svc.name}</a></h2>
            <span class="status-label" style="color:${color}">${label}</span>
          </div>
        </div>
        <div class="metrics-summary">
          ${svc.responseTimeMs !== null ? `<span class="metric-badge">${svc.responseTimeMs}ms</span>` : ''}
          ${svc.lagSeconds !== null ? `<span class="metric-badge ${svc.lagSeconds > 300 ? 'warn' : ''}">${formatLag(svc.lagSeconds)} lag</span>` : ''}
        </div>
      </div>

      <div class="timeline-container">
        <div class="timeline-section-label">24-Hour History</div>
        ${(() => { const tl = renderTimeline(hist); return `
        <div class="timeline">${tl.bars}</div>
        <div class="timeline-labels">
          <span>${tl.rangeLabel}</span>
          <span>${uptimePercent}% uptime</span>
          <span>Now</span>
        </div>`; })()}
      </div>

      <div class="timeline-container">
        <div class="timeline-section-label">30-Day History</div>
        ${(() => { const dl = renderDailyTimeline(dailyHist); return `
        <div class="timeline daily-timeline">${dl.bars}</div>
        <div class="timeline-labels">
          <span>30d ago</span>
          <span>${dl.uptimePercent !== '—' ? dl.uptimePercent + '% uptime' : 'No data'}</span>
          <span>Today</span>
        </div>`; })()}
      </div>

      <div class="metrics-grid">
        <div class="metric">
          <div class="metric-label">Latest Block</div>
          <div class="metric-value">${formatNumber(svc.latestBlock)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Block Lag</div>
          <div class="metric-value">${formatLag(svc.lagSeconds)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Response</div>
          <div class="metric-value">${svc.responseTimeMs !== null ? svc.responseTimeMs + 'ms' : '—'}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Uptime (24h)</div>
          <div class="metric-value">${uptimePercent === '—' ? '—' : uptimePercent + '%'}</div>
        </div>
        ${svc.dbSizeMB !== null ? `
        <div class="metric">
          <div class="metric-label">DB Size</div>
          <div class="metric-value">${svc.dbSizeMB > 1024 ? (svc.dbSizeMB / 1024).toFixed(1) + ' GB' : svc.dbSizeMB + ' MB'}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Transactions</div>
          <div class="metric-value">${formatNumber(svc.txRows)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Blocks</div>
          <div class="metric-value">${formatNumber(svc.blockRows)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">DB Conns</div>
          <div class="metric-value">${svc.activeConns ?? '—'} / ${svc.totalConns ?? '—'}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Heap Used</div>
          <div class="metric-value">${svc.heapUsedMB !== null ? svc.heapUsedMB + ' MB' : '—'}</div>
        </div>
        ` : ''}
      </div>

      ${svc.error ? `<div class="error-msg">${svc.error}</div>` : ''}
      ${svc.lastChecked ? `<div class="last-checked">Last checked: ${new Date(svc.lastChecked).toLocaleString()}</div>` : ''}
    </div>
  `
}

export function html(services: Record<string, ServiceHealth>, history: Record<string, HistoryEntry[]>, dailyHistory: Record<string, DailySummary[]>): string {
  const overall = overallStatus(services)
  const cards = Object.entries(services).map(([k, svc]) => serviceCard(k, svc, history[k] || [], dailyHistory[k] || [])).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Status — bnbscan.com & ethscan.io</title>
  <meta http-equiv="refresh" content="30">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0e17;
      color: #e2e8f0;
      min-height: 100vh;
      line-height: 1.5;
    }

    .container { max-width: 720px; margin: 0 auto; padding: 40px 20px; }

    .header { text-align: center; margin-bottom: 40px; }
    .header h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 16px; color: #f1f5f9; }

    .overall-status {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 10px 20px; border-radius: 9999px;
      font-size: 14px; font-weight: 500;
    }
    .overall-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

    .card {
      background: #111827;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
    }

    .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
    .service-info { display: flex; align-items: center; gap: 12px; }
    .status-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
    .service-name { font-size: 16px; font-weight: 600; }
    .service-name a { color: inherit; text-decoration: none; }
    .service-name a:hover { text-decoration: underline; }
    .status-label { font-size: 13px; font-weight: 500; }

    .metrics-summary { display: flex; gap: 8px; flex-wrap: wrap; }
    .metric-badge {
      font-size: 12px; font-weight: 500; padding: 3px 10px;
      background: #1e293b; border-radius: 9999px; color: #94a3b8;
    }
    .metric-badge.warn { background: #451a1a; color: #f59e0b; }

    .timeline-container { margin-bottom: 20px; }
    .timeline { display: flex; gap: 2px; height: 32px; align-items: stretch; }
    .bar { flex: 1; border-radius: 2px; min-width: 2px; transition: opacity 0.15s; }
    .bar:hover { opacity: 0.7; }
    .timeline-labels { display: flex; justify-content: space-between; font-size: 11px; color: #64748b; margin-top: 4px; }
    .timeline-section-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .daily-timeline { height: 24px; }
    .daily-bar { border-radius: 3px; }

    .metrics-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 12px;
    }
    .metric { padding: 10px 12px; background: #0f172a; border-radius: 8px; }
    .metric-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
    .metric-value { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }

    .error-msg {
      margin-top: 12px; padding: 8px 12px;
      background: #451a1a; border-radius: 6px;
      font-size: 12px; color: #fca5a5;
    }

    .last-checked { margin-top: 8px; font-size: 11px; color: #475569; }

    .footer {
      text-align: center; margin-top: 40px; padding-top: 20px;
      border-top: 1px solid #1e293b;
      font-size: 12px; color: #475569;
    }

    @media (max-width: 480px) {
      .card-header { flex-direction: column; gap: 12px; }
      .metrics-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>System Status</h1>
      <div class="overall-status" style="background:${overall.bg}; color:${overall.color}">
        <div class="overall-dot" style="background:${overall.color}"></div>
        ${overall.label}
      </div>
    </div>

    ${cards}

    <div class="footer">
      Auto-refreshes every 30 seconds &middot; Polling both services every 30s
    </div>
  </div>
</body>
</html>`
}
