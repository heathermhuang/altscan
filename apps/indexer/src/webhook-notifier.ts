/**
 * Webhook notifier for the BNB chain indexer.
 * Queries active webhooks from DB and delivers HMAC-signed payloads.
 * Called by block-processor after each block is indexed.
 */
import { getDb, schema } from '@bnbscan/db'
import { eq, or, and, inArray } from 'drizzle-orm'
import crypto from 'crypto'

type WebhookPayload = {
  event: 'tx' | 'token_transfer' | 'new_block'
  timestamp: string
  data: Record<string, unknown>
}

/**
 * Validate a webhook URL is safe to call (SSRF defense at delivery time).
 * DNS rebinding can cause a domain that pointed to a public IP at registration
 * to resolve to an internal IP at delivery time. Re-validate before every call.
 */
function isUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase()
    // Block internal/private networks
    const blockedHosts = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.|::1|fc00:|fe80:|0x|%)/
    if (blockedHosts.test(hostname)) return false
    // Block numeric IPs (DNS rebinding defense)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) return false
    return true
  } catch {
    return false
  }
}

async function deliverWebhook(url: string, secretHash: string, payload: WebhookPayload): Promise<boolean> {
  // Re-validate URL at delivery time (DNS rebinding defense)
  if (!isUrlSafe(url)) {
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
          // global webhooks (no address filter)
          ...(schema.webhooks.watchAddress ? [] : []),
          inArray(schema.webhooks.watchAddress, addrList),
        ),
      )
    )
  } catch (err) {
    console.error('[webhook-notifier] DB query error:', err)
    return
  }

  if (webhooks.length === 0) return

  for (const webhook of webhooks) {
    if (!webhook.secret) continue
    if (!webhook.eventTypes.includes('tx')) continue

    // Filter: if watchAddress set, only deliver txs involving that address
    const relevantTxs = webhook.watchAddress
      ? txs.filter(tx => tx.fromAddress === webhook.watchAddress || tx.toAddress === webhook.watchAddress)
      : txs

    for (const tx of relevantTxs) {
      const payload: WebhookPayload = {
        event: 'tx',
        timestamp: timestamp.toISOString(),
        data: {
          hash: tx.hash,
          blockNumber,
          from: tx.fromAddress,
          to: tx.toAddress,
          value: tx.value,
        },
      }

      const ok = await deliverWebhook(webhook.url, webhook.secret, payload)

      // Update lastTriggeredAt and failCount
      try {
        if (ok) {
          await db.update(schema.webhooks)
            .set({ lastTriggeredAt: new Date(), failCount: 0 })
            .where(eq(schema.webhooks.id, webhook.id))
        } else {
          // Increment failCount; deactivate after 5 consecutive failures
          const currentFail = (webhook as { failCount?: number }).failCount ?? 0
          const newFail = currentFail + 1
          await db.update(schema.webhooks)
            .set({
              failCount: newFail,
              ...(newFail >= 5 ? { active: false } : {}),
            })
            .where(eq(schema.webhooks.id, webhook.id))
          if (newFail >= 5) {
            console.warn(`[webhook-notifier] Deactivated webhook ${webhook.id} after ${newFail} consecutive failures`)
          }
        }
      } catch { /* non-fatal */ }
    }
  }
}
