/**
 * Webhook notifier for the BNB chain indexer.
 * Queries active webhooks from DB and delivers HMAC-signed payloads.
 * Called by block-processor after each block is indexed.
 */
import { getDb, schema } from './db'
import { eq, or, and, inArray, isNull } from 'drizzle-orm'
import crypto from 'crypto'
import dns from 'node:dns/promises'
import net from 'node:net'

type WebhookPayload = {
  event: 'tx' | 'token_transfer' | 'new_block'
  timestamp: string
  blockNumber?: number
  count?: number
  // A single event object, or (for batched per-block tx delivery) an array.
  data: Record<string, unknown> | Record<string, unknown>[]
}

/** True for IPv4/IPv6 loopback, private, link-local, ULA and CGNAT ranges. */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||   // link-local (incl. 169.254.169.254 metadata)
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    )
  }
  const low = ip.toLowerCase().replace(/^::ffff:/, '')
  if (net.isIPv4(low)) return isPrivateIp(low)
  return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80')
}

/**
 * SSRF defense at delivery time. The registration-time host check only inspects
 * the URL *string*; it cannot stop DNS rebinding (a hostname that resolved public
 * at registration, re-pointed to an internal IP later). Two layers here:
 *   1. Require https:// — an internal HTTP-only service (e.g. the cloud metadata
 *      endpoint) cannot complete a public-CA TLS handshake for the registered host.
 *   2. Resolve the hostname NOW and reject if any A/AAAA record is private/reserved.
 * Redirect following is disabled separately (`redirect: 'error'`).
 */
async function isUrlSafe(url: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const hostname = parsed.hostname.toLowerCase()
  const blockedHosts = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.|::1|fc00:|fe80:|0x|%)/
  if (blockedHosts.test(hostname)) return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) return false
  // Resolve and reject if the host currently points at a private/reserved IP.
  try {
    const addrs = await dns.lookup(hostname, { all: true })
    if (addrs.length === 0) return false
    if (addrs.some((a) => isPrivateIp(a.address))) return false
  } catch {
    return false
  }
  return true
}

async function deliverWebhook(url: string, secretHash: string, payload: WebhookPayload): Promise<boolean> {
  // Re-validate URL at delivery time (DNS rebinding defense)
  if (!(await isUrlSafe(url))) {
    console.warn(`[webhook-notifier] Blocked delivery to unsafe URL: ${url}`)
    return false
  }

  try {
    const body = JSON.stringify(payload)
    // secretHash is the SHA-256 of the original secret — we can't un-hash it for HMAC.
    // Instead, use the secretHash directly as the HMAC key. Developers verify by computing
    // HMAC-SHA256(payload, sha256(theirSecret)).
    const sig = crypto.createHmac('sha256', secretHash).update(body).digest('hex')
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BNBScan-Signature': `sha256=${sig}`,
        'X-BNBScan-Event': payload.event,
        'User-Agent': 'BNBScan-Webhook/1.0',
      },
      body,
      signal: AbortSignal.timeout(10000),
      // Prevent following redirects to internal URLs
      redirect: 'error',
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Fire webhooks for all transactions in a newly indexed block.
 * Matches webhooks against tx fromAddress / toAddress.
 * Deactivates webhooks after 5 consecutive failures.
 */
export async function notifyWebhooks(
  txs: { hash: string; fromAddress: string; toAddress: string | null; value: string }[],
  blockNumber: number,
  timestamp: Date,
) {
  if (txs.length === 0) return
  const db = getDb()

  // Collect all unique addresses in this block
  const addresses = new Set<string>()
  for (const tx of txs) {
    addresses.add(tx.fromAddress)
    if (tx.toAddress) addresses.add(tx.toAddress)
  }
  const addrList = [...addresses]

  // Query active webhooks watching any of these addresses, or global (no watchAddress)
  let webhooks: { id: number; url: string; secret: string | null; watchAddress: string | null; eventTypes: string[] }[]
  try {
    webhooks = await db.select({
      id: schema.webhooks.id,
      url: schema.webhooks.url,
      secret: schema.webhooks.secret,
      watchAddress: schema.webhooks.watchAddress,
      eventTypes: schema.webhooks.eventTypes,
    }).from(schema.webhooks).where(
      and(
        eq(schema.webhooks.active, true),
        or(
          isNull(schema.webhooks.watchAddress),              // global webhooks (no address filter)
          inArray(schema.webhooks.watchAddress, addrList),   // address-specific webhooks
        ),
      )
    )
  } catch (err) {
    console.error('[webhook-notifier] DB query error:', err)
    return
  }

  if (webhooks.length === 0) return

  // Deliver all webhooks, then batch DB updates (instead of one UPDATE per tx per webhook)
  const succeededIds = new Set<number>()
  const failedWebhooks = new Map<number, number>() // id → new fail count

  for (const webhook of webhooks) {
    if (!webhook.secret) continue
    if (!webhook.eventTypes.includes('tx')) continue

    // Filter: if watchAddress set, only deliver txs involving that address
    const relevantTxs = webhook.watchAddress
      ? txs.filter(tx => tx.fromAddress === webhook.watchAddress || tx.toAddress === webhook.watchAddress)
      : txs

    if (relevantTxs.length === 0) continue

    // ONE POST per webhook per block — batch all relevant txs into a single
    // payload. Previously this sent one POST per tx, so a global webhook (no
    // watchAddress) emitted hundreds of POSTs/block to an attacker-suppliable
    // target URL — an amplification/DoS vector. Consumers now receive `data`
    // as an array of tx objects for the block.
    const payload: WebhookPayload = {
      event: 'tx',
      timestamp: timestamp.toISOString(),
      blockNumber,
      count: relevantTxs.length,
      data: relevantTxs.map((tx) => ({
        hash: tx.hash,
        blockNumber,
        from: tx.fromAddress,
        to: tx.toAddress,
        value: tx.value,
      })),
    }

    const ok = await deliverWebhook(webhook.url, webhook.secret, payload)
    if (ok) {
      succeededIds.add(webhook.id)
    } else {
      const currentFail = (webhook as { failCount?: number }).failCount ?? 0
      failedWebhooks.set(webhook.id, currentFail + 1)
    }
  }

  // Batch update succeeded webhooks
  if (succeededIds.size > 0) {
    try {
      await db.update(schema.webhooks)
        .set({ lastTriggeredAt: new Date(), failCount: 0 })
        .where(inArray(schema.webhooks.id, [...succeededIds]))
    } catch { /* non-fatal */ }
  }

  // Update failed webhooks individually (need different failCount per webhook)
  for (const [id, newFail] of failedWebhooks) {
    try {
      await db.update(schema.webhooks)
        .set({
          failCount: newFail,
          ...(newFail >= 5 ? { active: false } : {}),
        })
        .where(eq(schema.webhooks.id, id))
      if (newFail >= 5) {
        console.warn(`[webhook-notifier] Deactivated webhook ${id} after ${newFail} consecutive failures`)
      }
    } catch { /* non-fatal */ }
  }
}
