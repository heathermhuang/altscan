import Link from 'next/link'

export function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-400 text-sm mt-auto">
      {/* MDT attribution bar */}
      <div className="border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🔍</span>
            <div>
              <p className="text-white font-semibold text-base leading-tight">BNBScan</p>
              <p className="text-gray-400 text-xs">The Alternative BNB Chain Explorer</p>
            </div>
          </div>
          <div className="text-center md:text-right">
            <p className="text-gray-500 text-xs mb-0.5">Maintained by</p>
            <a
              href="https://mdt.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-yellow-400 hover:text-yellow-300 font-semibold transition-colors"
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
          © {new Date().getFullYear()} BNBScan · Powered by{' '}
          <a href="https://www.bnbchain.org" target="_blank" rel="noopener noreferrer" className="text-yellow-500 hover:underline">BNB Chain</a>
        </p>
      </div>
    </footer>
  )
}
