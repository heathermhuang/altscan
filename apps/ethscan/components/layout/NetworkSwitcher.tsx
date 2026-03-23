'use client'
import { useState, useRef, useEffect } from 'react'
import { usePathname } from 'next/navigation'

const PEER_URL = process.env.NEXT_PUBLIC_PEER_URL ?? 'http://localhost:3000'

const NETWORKS = [
  {
    id: 'eth',
    label: 'Ethereum',
    short: 'ETH',
    color: 'bg-indigo-500',
    dot: 'bg-indigo-300',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4" aria-hidden="true">
        <path d="M12 2L19 12L12 16.5L5 12L12 2Z" fill="white" fillOpacity="0.9" />
        <path d="M12 16.5L19 12L12 22L5 12L12 16.5Z" fill="white" fillOpacity="0.6" />
      </svg>
    ),
    current: true,
    href: null,
  },
  {
    id: 'bnb',
    label: 'BNB Chain',
    short: 'BNB',
    color: 'bg-yellow-400',
    dot: 'bg-yellow-300',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4" aria-hidden="true">
        <path d="M12 2L20 7.5V16.5L12 22L4 16.5V7.5L12 2Z" fill="black" fillOpacity="0.8" />
        <line x1="6" y1="12" x2="18" y2="12" stroke="black" strokeWidth="2" strokeOpacity="0.4" />
        <circle cx="12" cy="12" r="2" fill="black" fillOpacity="0.8" />
      </svg>
    ),
    current: false,
    href: PEER_URL,
  },
]

export function NetworkSwitcher() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  // Close on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const current = NETWORKS.find(n => n.current)!

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/15 hover:bg-white/25 transition-colors text-[12px] font-semibold text-white border border-white/20"
        aria-label="Switch network"
        aria-expanded={open}
      >
        <span className={`w-2 h-2 rounded-full ${current.dot} shrink-0`} />
        {current.short}
        <svg
          className={`w-3 h-3 text-white/70 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-52 rounded-xl shadow-xl bg-white border border-gray-100 overflow-hidden z-50">
          <p className="px-3 pt-2.5 pb-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
            Switch Network
          </p>
          {NETWORKS.map(net => {
            const href = net.current ? null : `${net.href}${pathname}`
            return (
              <div key={net.id}>
                {net.current ? (
                  <div className="flex items-center gap-3 px-3 py-2.5 bg-indigo-50">
                    <span className={`w-7 h-7 rounded-full ${net.color} flex items-center justify-center shrink-0`}>
                      {net.icon}
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-gray-900">{net.label}</p>
                      <p className="text-[11px] text-indigo-600 font-medium">Currently viewing</p>
                    </div>
                    <svg className="ml-auto w-4 h-4 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                ) : (
                  <a
                    href={href!}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors"
                    onClick={() => setOpen(false)}
                  >
                    <span className={`w-7 h-7 rounded-full ${net.color} flex items-center justify-center shrink-0`}>
                      {net.icon}
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-gray-900">{net.label}</p>
                      <p className="text-[11px] text-gray-400">Switch explorer</p>
                    </div>
                    <svg className="ml-auto w-4 h-4 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </a>
                )}
              </div>
            )
          })}
          <div className="px-3 py-2 border-t border-gray-100 bg-gray-50">
            <p className="text-[10px] text-gray-400">
              Same page on the other chain
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
