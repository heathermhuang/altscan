import { ImageResponse } from 'next/og'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { chainConfig } from '@/lib/chain'
import { formatNativeToken, safeBigInt } from '@/lib/format'

export const alt = 'Transaction details'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function OGImage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params
  const isEth = chainConfig.key === 'eth'
  const bgColor = isEth ? '#0f172a' : '#1a1a2e'
  const accentColor = chainConfig.theme.primaryHex

  let status = ''
  let value = ''
  let from = ''
  let to = ''
  let block = ''

  try {
    const [tx] = await db.select().from(schema.transactions).where(eq(schema.transactions.hash, hash)).limit(1)
    if (tx) {
      status = tx.status ? 'Success' : 'Failed'
      value = `${formatNativeToken(safeBigInt(tx.value))} ${chainConfig.currency}`
      from = tx.fromAddress
      to = tx.toAddress ?? 'Contract Creation'
      block = `#${tx.blockNumber.toLocaleString()}`
    }
  } catch { /* DB error */ }

  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 60, background: bgColor, fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ width: 48, height: 48, background: accentColor, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isEth ? 'white' : 'black', fontWeight: '800', fontSize: 28, marginRight: 16 }}>
          {chainConfig.brandName.charAt(0)}
        </div>
        <div style={{ fontSize: 24, color: 'rgba(255,255,255,0.5)' }}>{chainConfig.brandDomain}</div>
      </div>
      <div style={{ fontSize: 20, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 2, textTransform: 'uppercase' as const }}>Transaction</div>
      <div style={{ fontSize: 32, fontWeight: '700', color: 'white', marginBottom: 24, wordBreak: 'break-all' as const }}>{hash.slice(0, 42)}...</div>
      <div style={{ display: 'flex', gap: 40 }}>
        {value && <div style={{ display: 'flex', flexDirection: 'column' }}><div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Value</div><div style={{ fontSize: 24, fontWeight: '700', color: accentColor }}>{value}</div></div>}
        {status && <div style={{ display: 'flex', flexDirection: 'column' }}><div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Status</div><div style={{ fontSize: 24, fontWeight: '700', color: status === 'Success' ? '#22c55e' : '#ef4444' }}>{status}</div></div>}
        {block && <div style={{ display: 'flex', flexDirection: 'column' }}><div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Block</div><div style={{ fontSize: 24, fontWeight: '700', color: 'white' }}>{block}</div></div>}
      </div>
    </div>,
    { ...size }
  )
}
