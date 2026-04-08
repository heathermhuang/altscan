import { ImageResponse } from 'next/og'
import { chainConfig } from '@/lib/chain'

export const alt = `${chainConfig.brandDomain} — ${chainConfig.tagline}`
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OGImage() {
  const letter = chainConfig.brandName.charAt(0)
  const isEth = chainConfig.key === 'eth'
  const bgColor = isEth ? '#0f172a' : '#1a1a2e'
  const accentColor = chainConfig.theme.primaryHex

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: bgColor,
        fontFamily: 'sans-serif',
      }}
    >
      {/* Logo */}
      <div
        style={{
          width: 96,
          height: 96,
          background: accentColor,
          borderRadius: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: isEth ? 'white' : 'black',
          fontWeight: '800',
          fontSize: 56,
          marginBottom: 32,
        }}
      >
        {letter}
      </div>

      {/* Brand name */}
      <div
        style={{
          fontSize: 64,
          fontWeight: '800',
          color: 'white',
          letterSpacing: '-2px',
          marginBottom: 12,
        }}
      >
        {chainConfig.brandDomain}
      </div>

      {/* Tagline */}
      <div
        style={{
          fontSize: 28,
          color: 'rgba(255,255,255,0.6)',
          marginBottom: 40,
        }}
      >
        {chainConfig.tagline}
      </div>

      {/* MDT attribution */}
      <div
        style={{
          fontSize: 18,
          color: accentColor,
          opacity: 0.8,
        }}
      >
        Maintained by Measurable Data Token (MDT)
      </div>
    </div>,
    { ...size }
  )
}
