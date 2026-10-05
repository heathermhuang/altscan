import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import Script from 'next/script'
import './globals.css'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { WebMcpProvider } from '@/components/agent/WebMcpProvider'
import { chainConfig } from '@/lib/chain'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })
const jetbrainsMono = JetBrains_Mono({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  // Not preloaded: mono is never the LCP element, and a second high-priority font
  // competed with the page on slow connections (+~450ms Lighthouse mobile LCP).
  preload: false,
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
        <main className="flex-1">{children}</main>
        <Footer />
        <WebMcpProvider />
      </body>
    </html>
  )
}
