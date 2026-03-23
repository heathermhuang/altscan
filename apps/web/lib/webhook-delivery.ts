import crypto from 'crypto'

export type WebhookPayload = {
  event: 'tx' | 'token_transfer'
  timestamp: string
  data: Record<string, unknown>
}

export async function deliverWebhook(
  url: string,
  secret: string,
  payload: WebhookPayload
): Promise<boolean> {
  try {
    const body = JSON.stringify(payload)
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex')
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
    })
    return res.ok
  } catch {
    return false
  }
}
