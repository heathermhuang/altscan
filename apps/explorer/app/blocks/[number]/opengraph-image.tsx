import { ImageResponse } from 'next/og'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { chainConfig } from '@/lib/chain'

export const alt = 'Block details'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function OGImage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params
  const blockNumber = Number(number)
  const isEth = chainConfig.key === 'eth'
  const bgColor = isEth ? '#0f172a' : '#1a1a2e'
  const accentColor = chainConfig.theme.primaryHex

  let txCount = 0
  let miner = ''

  if (!isNaN(blockNumber)) {
    try {
      const [block] = await db.select().from(schema.blocks).where(eq(schema.blocks.number, blockNumber)).limit(1)
      if (block) {
        txCount = block.txCount
        miner = block.miner
      }
    } catch { /* DB error */ }
  }

  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 60, background: bgColor, fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ width: 48, height: 48, background: accentColor, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isEth ? 'white' : 'black', fontWeight: '800', fontSize: 28, marginRight: 16 }}>
          {chainConfig.brandName.charAt(0)}
        </div>
        <div style={{ fontSize: 24, color: 'rgba(255,255,255,0.5)' }}>{chainConfig.brandDomain}</div>
      </div>
      <div style={{ fontSize: 20, color: 'rgba(255,255,255,0.4)', marginBottom: 8, letterSpacing: 2, textTransform: 'uppercase' as const }}>Block</div>
      <div style={{ fontSize: 56, fontWeight: '800', color: 'white', marginBottom: 32 }}>#{blockNumber.toLocaleString()}</div>
      <div style={{ display: 'flex', gap: 40 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}><div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Transactions</div><div style={{ fontSize: 24, fontWeight: '700', color: accentColor }}>{txCount.toLocaleString()}</div></div>
        {miner && <div style={{ display: 'flex', flexDirection: 'column' }}><div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>Validator</div><div style={{ fontSize: 20, fontWeight: '500', color: 'rgba(255,255,255,0.7)' }}>{miner.slice(0, 22)}...</div></div>}
      </div>
    </div>,
    { ...size }
  )
}
