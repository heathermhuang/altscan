import Link from 'next/link'

function FooterLogo() {
  return (
    <svg viewBox="0 0 36 36" fill="none" className="w-8 h-8 shrink-0" aria-hidden="true">
      <path
        d="M18 3L31 18L18 33L5 18Z"
        fill="rgba(255,255,255,0.05)"
        stroke="rgba(255,255,255,0.3)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M18 3L31 18L18 22Z" fill="rgba(255,255,255,0.25)" />
      <path d="M18 3L5 18L18 22Z" fill="rgba(255,255,255,0.1)" />
      <path d="M5 18L18 33L31 18L18 22Z" fill="rgba(255,255,255,0.15)" />
    </svg>
  )
}

export function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-400 text-sm mt-auto">
      {/* MDT attribution bar */}
      <div className="border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <FooterLogo />
            <div>
              <p className="text-white font-semibold text-base leading-tight">EthScan</p>
              <p className="text-gray-400 text-xs">The Alternative Ethereum Explorer</p>
            </div>
          </div>
          <div className="text-center md:text-right">
            <p className="text-gray-500 text-xs mb-0.5">Maintained by</p>
            <a
              href="https://mdt.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 font-semibold transition-colors"
            >
              Measurable Data Token (MDT)
            </a>
          </div>
        </div>
      </div>

      {/* Links + copyright */}
      <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="flex flex-wrap justify-center md:justify-start gap-4 text-xs">
          <Link href="/blocks" className="hover:text-gray-200 transition-colors">Blocks</Link>
          <Link href="/txs" className="hover:text-gray-200 transition-colors">Transactions</Link>
          <Link href="/token" className="hover:text-gray-200 transition-colors">Tokens</Link>
          <Link href="/charts" className="hover:text-gray-200 transition-colors">Charts</Link>
          <Link href="/api-docs" className="hover:text-gray-200 transition-colors">API</Link>
          <Link href="/developer" className="hover:text-gray-200 transition-colors">Developer</Link>
          <a href="https://mdt.io" target="_blank" rel="noopener noreferrer" className="hover:text-gray-200 transition-colors">MDT Website ↗</a>
        </div>
        <p className="text-xs text-gray-600">
          © {new Date().getFullYear()} EthScan · Powered by{' '}
          <a href="https://ethereum.org" target="_blank" rel="noopener noreferrer" className="text-indigo-500 hover:underline">Ethereum</a>
        </p>
      </div>
    </footer>
  )
}
