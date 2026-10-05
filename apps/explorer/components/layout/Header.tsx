'use client'
import Link from 'next/link'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { SearchBar } from './SearchBar'
import { NetworkSwitcher } from './NetworkSwitcher'
import { chainConfig } from '@/lib/chain-client'

const NAV_LINKS = [
  { href: '/blocks',     label: 'Blocks',            group: 'Explore' },
  { href: '/txs',        label: 'Transactions',      group: 'Explore' },
  { href: '/charts',     label: 'Charts',            group: 'Analytics' },
  { href: '/gas',        label: 'Gas Tracker',       group: 'Analytics' },
  ...(chainConfig.features.hasValidators ? [{ href: '/validators', label: 'Validators', group: 'Analytics' }] : []),
  ...(chainConfig.features.hasStaking ? [{ href: '/staking', label: 'Staking', group: 'Analytics' }] : []),
  { href: '/watchlist',  label: '⭐ Watchlist',      group: 'Tools' },
  { href: '/api-docs',   label: 'API Docs',          group: 'Developers' },
  { href: '/developer',  label: 'Developer Portal',  group: 'Developers' },
  { href: '/verify',     label: 'Verify Contract',   group: 'Developers' },
]

const DESKTOP_NAV = [
  { href: '/blocks',     label: 'Blocks' },
  { href: '/txs',        label: 'Txns' },
  { href: '/charts',     label: 'Charts' },
  { href: '/gas',        label: 'Gas' },
  ...(chainConfig.features.hasValidators ? [{ href: '/validators', label: 'Validators' }] : []),
  ...(chainConfig.features.hasStaking ? [{ href: '/staking', label: 'Staking' }] : []),
  { href: '/watchlist',  label: 'Watch' },
  { href: '/api-docs',   label: 'API' },
  { href: '/developer',  label: 'Dev' },
  { href: '/verify',     label: 'Verify' },
]

function BnbLogo() {
  return (
    <svg viewBox="0 0 36 36" fill="none" className="w-6 h-6" aria-hidden="true">
      <path
        d="M18 2L33 10.5V25.5L18 34L3 25.5V10.5L18 2Z"
        fill="currentColor"
        fillOpacity="0.1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <line x1="9"  y1="18" x2="27" y2="18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="12" y1="13" x2="24" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.4" />
      <line x1="12" y1="23" x2="24" y2="23" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.4" />
      <circle cx="18" cy="18" r="2.5" fill="currentColor" />
    </svg>
  )
}

function EthLogo() {
  return (
    <svg viewBox="0 0 36 36" fill="none" className="w-6 h-6" aria-hidden="true">
      {/* Ethereum diamond shape */}
      <path d="M18 3L28 18L18 24L8 18L18 3Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M18 24L28 18L18 33L8 18L18 24Z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <line x1="18" y1="3" x2="18" y2="33" stroke="currentColor" strokeWidth="1" strokeOpacity="0.3" />
    </svg>
  )
}

const LOGOS = { bnb: BnbLogo, eth: EthLogo }

function Logo() {
  // Keyed by ChainKey, so adding a chain is a compile error here rather than a
  // silent fall-through to BNB's mark.
  const ChainLogo = LOGOS[chainConfig.key]
  return <ChainLogo />
}

export function Header() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Close mobile menu on route change
  useEffect(() => { setOpen(false) }, [pathname])

  const groups = [...new Set(NAV_LINKS.map(l => l.group))]

  return (
    <header className="sticky top-0 z-50 border-t-[3px] border-t-acc border-b border-b-hair bg-card/90 backdrop-blur-md">

      {/* -- Top bar: logo + switcher + search (xl) + desktop nav + hamburger -- */}
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] bg-acc text-acc-on">
              <Logo />
            </span>
            <div className="leading-tight">
              <span className="font-mono font-semibold text-[15px] tracking-tight block">{chainConfig.brandDomain}</span>
              <span className="text-[11px] text-mut hidden sm:block leading-none mt-0.5">
                by Measurable Data Token
              </span>
            </div>
          </Link>

          {/* Network switcher */}
          <NetworkSwitcher />

          {/* Search: the home hero owns it on `/`. Own row below xl, inline from xl. */}
          {pathname !== '/' && (
            <div className="order-last basis-full xl:order-none xl:basis-auto xl:w-[22rem] xl:shrink-0">
              <SearchBar />
            </div>
          )}

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-0.5 text-[13px] font-medium flex-1 justify-end">
            {DESKTOP_NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                title={label === '⭐' ? 'Watchlist' : undefined}
                aria-current={pathname === href ? 'page' : undefined}
                className={`px-1.5 lg:px-2.5 py-2 border-b-2 transition-colors whitespace-nowrap ${
                  pathname === href ? 'text-acc-ink border-acc font-semibold' : 'text-ink2 hover:text-ink border-transparent'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* Hamburger -- mobile only */}
          <button
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="md:hidden ml-auto flex flex-col justify-center items-center w-9 h-9 gap-1.5 rounded-[9px] border border-hair bg-card hover:border-hair3 transition-colors"
          >
            <span className={`block h-0.5 w-5 bg-current rounded transition-all duration-200 origin-center ${open ? 'rotate-45 translate-y-2' : ''}`} />
            <span className={`block h-0.5 w-5 bg-current rounded transition-all duration-200 ${open ? 'opacity-0 scale-x-0' : ''}`} />
            <span className={`block h-0.5 w-5 bg-current rounded transition-all duration-200 origin-center ${open ? '-rotate-45 -translate-y-2' : ''}`} />
          </button>
        </div>
      </div>

      {/* -- Mobile menu panel -- */}
      {open && (
        <div className="md:hidden border-t border-hair bg-card max-h-[calc(100dvh-7rem)] overflow-y-auto">
          <div className="max-w-7xl mx-auto px-4 pt-3 pb-1">
            <NetworkSwitcher />
          </div>
          <div className="max-w-7xl mx-auto px-4 py-4 space-y-5">
            {groups.map(group => (
              <div key={group}>
                <p className="k text-[11px] mb-1">
                  <span aria-hidden="true">{'// '}</span>{group}
                </p>
                <div className="border-t border-hair">
                  {NAV_LINKS.filter(l => l.group === group).map(link => (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={pathname === link.href ? 'page' : undefined}
                      className={`block border-b border-b-hair border-l-2 pl-3 py-2.5 text-sm transition-colors ${
                        pathname === link.href
                          ? 'border-l-acc text-acc-ink font-semibold'
                          : 'border-l-transparent text-ink2 hover:text-ink'
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
