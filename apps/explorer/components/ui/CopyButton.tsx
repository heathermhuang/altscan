'use client'
import { useState } from 'react'
import { BinanceReferralAd } from '@/components/ads/BinanceReferralAd'
import type { BinanceReferralPlacement } from '@/lib/binance-referral'

export function CopyButton({
  text,
  referralPlacement,
}: {
  text: string
  referralPlacement?: BinanceReferralPlacement
}) {
  const [copied, setCopied] = useState(false)
  const [showReferral, setShowReferral] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      if (referralPlacement) {
        setShowReferral(true)
        setTimeout(() => setShowReferral(false), 6000)
      }
    } catch (err) {
      console.error('Failed to copy to clipboard:', err)
    }
  }

  return (
    <span className="relative inline-flex items-center">
      <button onClick={copy} className="text-xs text-gray-400 hover:text-gray-600 ml-1" title="Copy">
        {copied ? '✓' : '⎘'}
      </button>
      {showReferral && referralPlacement && (
        <div className="absolute left-0 top-full z-50 mt-2">
          <BinanceReferralAd
            context="address_copy"
            placement={referralPlacement}
            variant="popover"
          />
        </div>
      )}
    </span>
  )
}
