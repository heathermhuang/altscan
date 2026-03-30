import { ImageResponse } from 'next/og'
import { chainConfig } from '@/lib/chain'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  const letter = chainConfig.brandName.charAt(0)
  return new ImageResponse(
    <div
      style={{
        width: 32,
        height: 32,
        background: chainConfig.theme.primaryHex,
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontWeight: '800',
        fontSize: 18,
        fontFamily: 'sans-serif',
        letterSpacing: '-1px',
      }}
    >
      {letter}
    </div>,
    { ...size }
  )
}
