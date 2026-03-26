'use client'
import Link from 'next/link'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { SearchBar } from './SearchBar'
import { NetworkSwitcher } from './NetworkSwitcher'

const NAV_LINKS = [
  { href: '/blocks',   label: 'Blocks',          group: 'Explore' },
  { href: '/txs',      label: 'Transactions',    group: 'Explore' },
  { href: '/token',    label: 'Tokens',          group: 'Explore' },
  { href: '/dex',      label: 'DEX Trades',      group: 'Explore' },
  { href: '/charts',   label: 'Charts',          group: 'Analytics' },
  { href: '/whales',   label: 'Whale Tracker',   group: 'Analytics' },
  { href: '/gas',      label: 'Gas Tracker',     group: 'Analytics' },
  { href: '/staking',  label: 'Staking',         group: 'Analytics' },
  { href: '/watchlist',label: '⭐ Watchlist',    group: 'Tools' },
  { href: '/api-docs', label: 'API Docs',        group: 'Developers' },
  { href: '/developer',label: 'Developer Portal',group: 'Developers' },
  { href: '/verify',   label: 'Verify Contract', group: 'Developers' },
]

const DESKTOP_NAV = [
  { href: '/blocks',   label: 'Blocks' },
  { href: '/txs',      label: 'Txns' },
  { href: '/token',    label: 'Tokens' },
  { href: '/dex',      label: 'DEX' },
  { href: '/charts',   label: 'Charts' },
  { href: '/whales',   label: 'Whales' },
  { href: '/gas',      label: 'Gas' },
  { href: '/staking',  label: 'Staking' },
  { href: '/watchlist',label: '⭐' },
  { href: '/api-docs', label: 'API' },
  { href: '/developer',label: 'Dev' },
  { href: '/verify',   label: 'Verify' },
]

function Logo() {
  return (
    <svg viewBox="0 0 36 36" fill="none" className="w-8 h-8 shrink-0" aria-hidden="true">
      {/* Ethereum diamond shape */}
      <path
        d="M18 3L31 18L18 33L5 18Z"
        fill="rgba(255,255,255,0.15)"
        stroke="white"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M18 3L31 18L18 22Z"
        fill="rgba(255,255,255,0.3)"
      />
      <path
        d="M18 3L5 18L18 22Z"
        fill="rgba(255,255,255,0.15)"
      />
      <path
        d="M5 18L18 33L31 18L18 22Z"
        fill="rgba(255,255,255,0.2)"
      />
    </svg>
  )
}

export function Header() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => { setOpen(false) }, [pathname])

  const groups = [...new Set(NAV_LINKS.map(l => l.group))]

  return (
    <header className="bg-indigo-600 text-white shadow-md sticky top-0 z-50">

      {/* ── Top bar: logo + desktop nav + hamburger ── */}
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center h-14 gap-3">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <Logo />
            <div className="leading-tight">
              <span className="font-black text-[17px] tracking-tight block">EthScan.io</span>
              <span className="text-[10px] text-white/60 font-medium hidden sm:block leading-none">
                by Measurable Data Token
              </span>
            </div>
          </Link>

          {/* Network switcher */}
          <NetworkSwitcher />

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-0.5 text-[13px] font-medium flex-1 justify-end">
            {DESKTOP_NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                title={label === '⭐' ? 'Watchlist' : undefined}
                className={`px-2.5 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                  pathname === href ? 'bg-white/20 font-semibold' : 'hover:bg-white/10'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* Hamburger — mobile only */}
          <button
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="md:hidden ml-auto flex flex-col justify-center items-center w-9 h-9 gap-1.5 rounded-lg hover:bg-white/10 transition-colors"
          >
            <span className={`block h-0.5 w-5 bg-white rounded transition-all duration-200 origin-center ${open ? 'rotate-45 translate-y-2' : ''}`} />
            <span className={`block h-0.5 w-5 bg-white rounded transition-all duration-200 ${open ? 'opacity-0 scale-x-0' : ''}`} />
            <span className={`block h-0.5 w-5 bg-white rounded transition-all duration-200 origin-center ${open ? '-rotate-45 -translate-y-2' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── Search row (always visible) ── */}
      <div className="border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-2">
          <SearchBar />
        </div>
      </div>

      {/* ── Mobile menu panel ── */}
      {open && (
        <div className="md:hidden border-t border-white/10 bg-indigo-700">
          <div className="max-w-7xl mx-auto px-4 pt-3 pb-1">
            <NetworkSwitcher />
          </div>
          <div className="max-w-7xl mx-auto px-4 py-4 space-y-5">
            {groups.map(group => (
              <div key={group}>
                <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-2">
                  {group}
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {NAV_LINKS.filter(l => l.group === group).map(link => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                        pathname === link.href
                          ? 'bg-white/20 text-white font-semibold'
                          : 'hover:bg-white/10 text-white/80'
                      }`}
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </header>
  )
}
