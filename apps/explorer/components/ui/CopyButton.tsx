'use client'
import { useState } from 'react'
import { AdSlot } from '@/components/ads/AdSlot'
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
      <button
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        title="Copy"
        className={`ml-1 inline-flex h-6 w-6 items-center justify-center rounded-[6px] border border-hair bg-card text-xs hover:border-hair3 transition-colors ${copied ? 'text-live' : 'text-mut hover:text-ink'}`}
      >
        <span aria-hidden="true">{copied ? '✓' : '⎘'}</span>
      </button>
      {showReferral && referralPlacement && (
        <div className="absolute left-0 top-full z-50 mt-2">
          <AdSlot
            context="address_copy"
            placement={referralPlacement}
            variant="popover"
          />
        </div>
      )}
    </span>
  )
}
