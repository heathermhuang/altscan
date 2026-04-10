import Link from 'next/link'
import { NetworkSwitcher } from './NetworkSwitcher'
import { chainConfig } from '@/lib/chain'

function FooterLogo() {
  return (
    <svg viewBox="0 0 36 36" fill="none" className="w-8 h-8 shrink-0" aria-hidden="true">
      <path
        d="M18 2L33 10.5V25.5L18 34L3 25.5V10.5L18 2Z"
        fill="rgba(255,255,255,0.05)"
        stroke="rgba(255,255,255,0.4)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <line x1="9"  y1="18" x2="27" y2="18" stroke="rgba(255,255,255,0.7)" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="12" y1="13" x2="24" y2="13" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="12" y1="23" x2="24" y2="23" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="18" cy="18" r="2.5" fill="rgba(255,255,255,0.7)" />
    </svg>
  )
}

export function Footer() {
  const { theme } = chainConfig

  return (
    <footer className="bg-gray-900 text-gray-400 text-sm mt-auto">
      {/* MDT attribution bar */}
      <div className="border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <FooterLogo />
            <div>
              <p className="text-white font-semibold text-base leading-tight">{chainConfig.brandDomain}</p>
              <p className="text-gray-400 text-xs">{chainConfig.tagline}</p>
            </div>
          </div>
          <div className="text-center md:text-right">
            <p className="text-gray-500 text-xs mb-0.5">Maintained by</p>
            <a
              href="https://mdt.io"
              target="_blank"
              rel="noopener noreferrer"
              className={`${theme.footerAccent} hover:opacity-80 font-semibold transition-colors py-1 inline-block`}
            >
              Measurable Data Token (MDT)
            </a>
          </div>
        </div>
      </div>

      {/* Links + network switcher + copyright */}
      <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex flex-wrap justify-center md:justify-start gap-x-4 gap-y-1 text-sm">
          <Link href="/blocks" className="hover:text-gray-200 transition-colors py-2">Blocks</Link>
          <Link href="/txs" className="hover:text-gray-200 transition-colors py-2">Transactions</Link>
          <Link href="/token" className="hover:text-gray-200 transition-colors py-2">Tokens</Link>
          <Link href="/charts" className="hover:text-gray-200 transition-colors py-2">Charts</Link>
          <Link href="/api-docs" className="hover:text-gray-200 transition-colors py-2">API</Link>
          <Link href="/developer" className="hover:text-gray-200 transition-colors py-2">Developer</Link>
          <Link href="/about" className="hover:text-gray-200 transition-colors py-2">About</Link>

          <a href="https://github.com/heathermhuang/bnbscan" target="_blank" rel="noopener noreferrer" className="hover:text-gray-200 transition-colors py-2">GitHub ↗</a>
          <a href="https://status-page-6ez4.onrender.com" target="_blank" rel="noopener noreferrer" className="hover:text-gray-200 transition-colors py-2">Status ↗</a>
        </div>
        <div className="flex items-center gap-4">
          <NetworkSwitcher direction="up" theme="footer" />
          <p className="text-xs text-gray-600">
            &copy; {new Date().getFullYear()} {chainConfig.brandDomain} &middot; Not affiliated with {chainConfig.notAffiliatedWith}
          </p>
        </div>
      </div>
    </footer>
  )
}
