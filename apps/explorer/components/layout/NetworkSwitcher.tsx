'use client'
import { useState, useRef, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { getChainConfig } from '@altscan/chain-config'
import { chainConfig } from '@/lib/chain-client'

const isDev = process.env.NODE_ENV === 'development'
const PEER_URL = isDev ? chainConfig.peerDevUrl : chainConfig.peerUrl

// Each network's own swatch colours come from its chain-config theme, so this
// list never hardcodes a chain colour.
const NETWORKS = [
  {
    id: 'bnb',
    label: 'BNB Chain',
    short: 'BNB',
    theme: getChainConfig('bnb').theme,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4" aria-hidden="true">
        <path d="M12 2L20 7.5V16.5L12 22L4 16.5V7.5L12 2Z" fill="currentColor" fillOpacity="0.7" />
        <line x1="6" y1="12" x2="18" y2="12" stroke="currentColor" strokeWidth="2" strokeOpacity="0.35" />
        <circle cx="12" cy="12" r="2" fill="currentColor" fillOpacity="0.7" />
      </svg>
    ),
  },
  {
    id: 'eth',
    label: 'Ethereum',
    short: 'ETH',
    theme: getChainConfig('eth').theme,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4" aria-hidden="true">
        <path d="M12 2L19 12L12 16.5L5 12L12 2Z" fill="currentColor" fillOpacity="0.9" />
        <path d="M12 16.5L19 12L12 22L5 12L12 16.5Z" fill="currentColor" fillOpacity="0.6" />
      </svg>
    ),
  },
]

export function NetworkSwitcher({ direction = 'down' }: { direction?: 'down' | 'up' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Mark current network based on chain config key
  const currentKey = chainConfig.key

  const current = NETWORKS.find(n => n.id === currentKey)!
  const chevronOpen = direction === 'up' ? !open : open

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 h-8 px-3 rounded-full border border-hair bg-card hover:border-hair3 transition-colors font-mono text-xs font-medium text-ink"
        aria-label="Switch network"
        aria-expanded={open}
      >
        <span className="w-2 h-2 rounded-[2px] bg-acc shrink-0" />
        {current.short}
        <svg
          className={`w-3 h-3 text-mut transition-transform duration-150 ${chevronOpen ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className={`absolute left-0 w-56 rounded-xl border border-hair bg-card shadow-[0_10px_30px_rgba(16,16,20,0.12)] overflow-hidden z-50 ${
          direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
        }`}>
          <p className="k text-[11px] px-3 pt-2.5 pb-1.5">
            Switch Network
          </p>
          {NETWORKS.map(net => {
            const isCurrent = net.id === currentKey
            const href = isCurrent ? null : `${PEER_URL}${pathname}`
            const mark = (
              <span
                className="net-mark w-7 h-7 rounded-[3px] flex items-center justify-center shrink-0"
                style={{
                  '--nm-l': net.theme.accentHex,
                  '--nm-on-l': net.theme.accentOn,
                  '--nm-d': net.theme.accentHexDark,
                  '--nm-on-d': net.theme.accentOnDark,
                } as React.CSSProperties}
              >
                {net.icon}
              </span>
            )
            return (
              <div key={net.id}>
                {isCurrent ? (
                  <div className="flex items-center gap-3 px-3 py-2.5 bg-hair2">
                    {mark}
                    <div>
                      <p className="text-[13px] font-semibold text-ink">{net.label}</p>
                      <p className="font-mono text-[11px] text-acc-ink">Currently viewing</p>
                    </div>
                    <svg className="ml-auto w-4 h-4 text-acc-ink shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                ) : (
                  <a
                    href={href!}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-hair2 transition-colors"
                    onClick={() => setOpen(false)}
                  >
                    {mark}
                    <div>
                      <p className="text-[13px] font-semibold text-ink">{net.label}</p>
                      <p className="font-mono text-[11px] text-mut">Switch explorer</p>
                    </div>
                    <svg className="ml-auto w-4 h-4 text-mut shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </a>
                )}
              </div>
            )
          })}
          <div className="px-3 py-2 border-t border-hair bg-canvas">
            <p className="font-mono text-[11px] text-mut">
              Same page on the other chain
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
