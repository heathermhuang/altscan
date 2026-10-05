import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import localFont from 'next/font/local'
import Script from 'next/script'
import './globals.css'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { WebMcpProvider } from '@/components/agent/WebMcpProvider'
import { chainConfig } from '@/lib/chain'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })
// JetBrains Mono, subset to Basic Latin plus the UI's arrows (fonts/OFL.txt): one 8 KB variable
// file for weights 400-600 instead of Google's 32 KB latin file, which sat on the critical path
// behind the CSS and cost ~450ms of Lighthouse mobile LCP. No ligatures, so hashes render as typed.
// Not preloaded and `optional`: a second preloaded font made the first frame land before React's
// reveal of the streamed page (app/loading.tsx), deferring it ~300ms (late LCP + footer shift),
// and a swap re-wraps long hashes. A cold first visit may show the fallback mono.
const jetbrainsMono = localFont({
  src: './fonts/JetBrainsMono-subset.woff2',
  weight: '400 600',
  display: 'optional',
  preload: false,
  variable: '--font-mono',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
  // The default Arial-metrics fallback is wrong for a monospace face.
  adjustFontFallback: false,
})

export const metadata: Metadata = {
  metadataBase: new URL(`https://${chainConfig.domain}`),
  title: {
    default: `${chainConfig.brandDomain} — ${chainConfig.tagline}`,
    template: `%s — ${chainConfig.brandDomain}`,
  },
  description: `${chainConfig.brandDomain} is an alternative ${chainConfig.name} block explorer maintained by Measurable Data Token (MDT). Explore blocks, transactions, tokens, DEX trades, and more.`,
  openGraph: {
    title: `${chainConfig.brandDomain} — ${chainConfig.tagline}`,
    description: `An open, independent ${chainConfig.name} explorer maintained by Measurable Data Token (MDT).`,
    siteName: `${chainConfig.brandDomain} by MDT`,
    type: 'website',
    url: `https://${chainConfig.domain}`,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${chainConfig.brandDomain} — ${chainConfig.tagline}`,
    description: `An open, independent ${chainConfig.name} explorer maintained by Measurable Data Token (MDT).`,
  },
  alternates: {
    canonical: '/',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      style={{
        '--acc': chainConfig.theme.accentHex,
        '--acc-ink': chainConfig.theme.accentInk,
        '--acc-t': chainConfig.theme.accentTint,
        '--acc-on': chainConfig.theme.accentOn,
      } as React.CSSProperties}
    >
      <body className="bg-canvas text-ink font-sans min-h-screen flex flex-col">
        {/* First tab stop: hidden until focused, then pinned above the sticky header (z-50). */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-[9px] focus:border focus:border-hair focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:ring-2 focus:ring-acc"
        >
          Skip to content
        </a>
        {/* Google Analytics */}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${chainConfig.gaTrackingId}`}
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${chainConfig.gaTrackingId}');
          `}
        </Script>
        <Header />
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">{children}</main>
        <Footer />
        <WebMcpProvider />
      </body>
    </html>
  )
}
