import { ImageResponse } from 'next/og'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { chainConfig } from '@/lib/chain'

export const alt = 'Token details'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function OGImage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params
  const isEth = chainConfig.key === 'eth'
  const bgColor = isEth ? '#0f172a' : '#1a1a2e'
  const accentColor = chainConfig.theme.primaryHex

  let name = 'Unknown Token'
  let symbol = '???'
  let type = isEth ? 'ERC-20' : 'BEP-20'
  let holders = 0

  try {
    const [token] = await db.select().from(schema.tokens).where(eq(schema.tokens.address, address.toLowerCase())).limit(1)
    if (token) {
      name = token.name
      symbol = token.symbol
      type = token.type
      holders = token.holderCount
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
      <div style={{ fontSize: 20, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 2, textTransform: 'uppercase' as const }}>{type} Token</div>
      <div style={{ fontSize: 48, fontWeight: '800', color: 'white', marginBottom: 8 }}>{name}</div>
      <div style={{ fontSize: 28, color: accentColor, fontWeight: '600', marginBottom: 32 }}>{symbol}</div>
      <div style={{ display: 'flex', gap: 40 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}><div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Holders</div><div style={{ fontSize: 24, fontWeight: '700', color: 'white' }}>{holders.toLocaleString()}</div></div>
        <div style={{ display: 'flex', flexDirection: 'column' }}><div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Contract</div><div style={{ fontSize: 20, fontWeight: '500', color: 'rgba(255,255,255,0.7)' }}>{address.slice(0, 22)}...</div></div>
      </div>
    </div>,
    { ...size }
  )
}
