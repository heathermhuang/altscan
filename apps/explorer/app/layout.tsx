import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import Script from 'next/script'
import './globals.css'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { chainConfig } from '@/lib/chain'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: `${chainConfig.brandDomain} — ${chainConfig.tagline}`,
  description: `${chainConfig.brandDomain} is an alternative ${chainConfig.name} block explorer maintained by Measurable Data Token (MDT). Explore blocks, transactions, tokens, DEX trades, and more.`,
  openGraph: {
    title: `${chainConfig.brandDomain} — ${chainConfig.tagline}`,
    description: `An open, independent ${chainConfig.name} explorer maintained by Measurable Data Token (MDT).`,
    siteName: `${chainConfig.brandDomain} by MDT`,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-gray-50 text-gray-900 min-h-screen flex flex-col`}>
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
      </body>
    </html>
  )
}
