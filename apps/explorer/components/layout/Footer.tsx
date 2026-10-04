import Link from 'next/link'
import { NetworkSwitcher } from './NetworkSwitcher'
import { chainConfig } from '@/lib/chain'
import { AdSlot } from '@/components/ads/AdSlot'
import { getSetting } from '@/lib/settings'
import { resolveFooterText, resolveLinks } from '@/lib/settings-defaults'

function FooterLogo() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] bg-acc text-acc-on">
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
    </span>
  )
}

export async function Footer() {
  const [linksOverride, footerOverride] = await Promise.all([
    getSetting('links'),
    getSetting('footer'),
  ])
  const quickLinks = resolveLinks(linksOverride)
  const { tagline, notAffiliatedWith } = resolveFooterText(footerOverride, chainConfig)

  return (
    <footer className="bg-card border-t border-hair text-mut text-sm mt-auto">
      {/* The footer ad variant is styled for a dark surface (translucent gray-950). */}
      <div className="bg-ink">
        <AdSlot
          context="footer"
          placement="footer_strip"
          variant="footer"
        />
      </div>

      {/* MDT attribution bar */}
      <div className="border-b border-hair">
        <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <FooterLogo />
            <div>
              <p className="font-mono text-ink font-semibold text-[15px] leading-tight">{chainConfig.brandDomain}</p>
              <p className="text-mut text-xs">{tagline}</p>
            </div>
          </div>
          <div className="text-center md:text-right">
            <p className="k text-[11px] mb-0.5">Maintained by</p>
            <a
              href="https://mdt.io"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-acc-ink hover:underline font-semibold py-1 inline-block"
            >
              Measurable Data Token (MDT)
            </a>
            <a
              href="https://altscan.io"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-acc-ink hover:underline text-xs font-medium mt-1.5 block"
            >
              Powered by Altscan ↗
            </a>
          </div>
        </div>
      </div>

      {/* Links + network switcher + copyright */}
      <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex flex-wrap justify-center md:justify-start gap-x-4 gap-y-1 font-mono text-[12.5px]">
          {quickLinks.map((l) =>
            l.href.startsWith('/') ? (
              <Link key={`${l.label}-${l.href}`} href={l.href} className="text-mut hover:text-ink transition-colors py-2">
                {l.label}
              </Link>
            ) : (
              <a
                key={`${l.label}-${l.href}`}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-mut hover:text-ink transition-colors py-2"
              >
                {l.label} ↗
              </a>
            ),
          )}
        </div>
        <div className="flex items-center gap-4">
          <NetworkSwitcher direction="up" />
          <p className="font-mono text-xs text-mut">
            &copy; {new Date().getFullYear()} {chainConfig.brandDomain} &middot; Not affiliated with {notAffiliatedWith}
          </p>
        </div>
      </div>
    </footer>
  )
}
