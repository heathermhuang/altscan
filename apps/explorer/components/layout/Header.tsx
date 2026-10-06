'use client'
import Link from 'next/link'
import { useState, useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { SearchBar } from './SearchBar'
import { NetworkSwitcher } from './NetworkSwitcher'
import { chainConfig } from '@/lib/chain-client'

// One list for the desktop nav and the mobile menu (the mobile menu groups it by `group`).
// `more` links sit behind the desktop nav's More disclosure. `glyph` is decoration only: the same
// ☆ WatchlistButton uses, hidden from assistive tech.
type NavLink = { href: string; label: string; group: string; more?: boolean; glyph?: string }

const NAV_LINKS: NavLink[] = [
  { href: '/blocks',     label: 'Blocks',        group: 'Explore' },
  { href: '/txs',        label: 'Transactions',  group: 'Explore' },
  { href: '/token',      label: 'Tokens',        group: 'Explore' },
  { href: '/dex',        label: 'DEX',           group: 'Markets' },
  { href: '/whales',     label: 'Whales',        group: 'Markets' },
  { href: '/charts',     label: 'Charts',        group: 'Analytics' },
  { href: '/gas',        label: 'Gas',           group: 'Analytics' },
  ...(chainConfig.features.hasValidators ? [{ href: '/validators', label: 'Validators', group: 'Analytics', more: true }] : []),
  ...(chainConfig.features.hasStaking ? [{ href: '/staking', label: 'Staking', group: 'Analytics', more: true }] : []),
  { href: '/watchlist',  label: 'Watchlist',     group: 'Tools', more: true, glyph: '☆' },
  { href: '/api-docs',   label: 'API',           group: 'Developers', more: true },
  { href: '/developer',  label: 'Developers',    group: 'Developers', more: true },
  { href: '/verify',     label: 'Verify',        group: 'Developers', more: true },
]
const MAIN_LINKS = NAV_LINKS.filter(l => !l.more)
const MORE_LINKS = NAV_LINKS.filter(l => l.more)

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

// The desktop nav's overflow: a disclosure (button + list of links) in the NetworkSwitcher's
// mould. Escape closes it and puts focus back on the button; a click, or Tab, outside closes it.
function MoreNav({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => { setOpen(false) }, [pathname])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      if (box.current?.contains(e.target as Node)) button.current?.focus()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div
      ref={box}
      className="nav-m"
      // Tab past the last link closes it. Only when focus lands somewhere: clicking blank space
      // (no relatedTarget) is the mousedown handler's.
      onBlur={e => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="nav-more"
        data-on={MORE_LINKS.some(l => l.href === pathname) || undefined}
      >
        More
        <svg
          className={open ? 'rotate-180' : undefined}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <ul id="nav-more" className="nav-p">
          {MORE_LINKS.map(({ href, label, glyph }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={pathname === href ? 'page' : undefined}
                onClick={() => setOpen(false)}
              >
                {glyph && <span aria-hidden="true">{glyph} </span>}{label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Header() {
  const [open, setOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const menuPanel = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  // Close mobile menu on route change
  useEffect(() => { setOpen(false) }, [pathname])

  // Escape closes the open mobile menu. Focus goes back to the hamburger only if it was in the menu
  // (or on the button), so Escape in the search box still leaves the caret there.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      const t = e.target as Node
      if (menuButton.current?.contains(t) || menuPanel.current?.contains(t)) menuButton.current?.focus()
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // `/` jumps to search (the header's, or the hero's on `/`), unless the user is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select') || t.isContentEditable) return
      const input = document.querySelector<HTMLInputElement>('form[role="search"] input')
      if (!input) return
      e.preventDefault()
      input.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const groups = [...new Set(NAV_LINKS.map(l => l.group))]

  return (
    <header className="hd">

      {/* -- Top bar: logo + switcher + desktop nav (lg) or hamburger + search (inline from xl, else its own row) -- */}
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">

          {/* Logo */}
          <Link href="/" className="brand">
            <span className="mark">
              <Logo />
            </span>
            <div className="leading-tight">
              <span className="brand-n">{chainConfig.brandDomain}</span>
              <span className="brand-t">
                by Measurable Data Token
              </span>
            </div>
          </Link>

          {/* Network switcher */}
          <NetworkSwitcher />

          {/* Desktop nav */}
          <nav className="nav">
            {MAIN_LINKS.map(({ href, label }) => (
              <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>
                {label}
              </Link>
            ))}
            <MoreNav pathname={pathname} />
          </nav>

          {/* Hamburger -- below lg, where the full-word nav no longer fits beside the logo */}
          <button
            ref={menuButton}
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="mobile-menu"
            className="burger"
          >
            <span className={open ? 'rotate-45 translate-y-2' : undefined} />
            <span className={open ? 'opacity-0 scale-x-0' : undefined} />
            <span className={open ? '-rotate-45 -translate-y-2' : undefined} />
          </button>

          {/* Search: the home hero owns it on `/`. Last in the row, so when xl's 1248px has no room for
              it beside the nav it wraps onto its own row (as it always does below xl) instead of the nav. */}
          {pathname !== '/' && (
            <div className="hdr-s">
              <SearchBar />
            </div>
          )}
        </div>
      </div>

      {/* -- Mobile menu panel -- */}
      {open && (
        <div ref={menuPanel} id="mobile-menu" className="lg:hidden border-t border-hair bg-card max-h-[calc(100dvh-7rem)] overflow-y-auto">
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
                      {link.glyph && <span aria-hidden="true">{link.glyph} </span>}{link.label}
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
