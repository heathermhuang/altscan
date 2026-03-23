import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'BNBScan — The Alternative BNB Chain Explorer',
  description: 'BNBScan is an alternative BNB Chain block explorer maintained by Measurable Data Token (MDT). Explore blocks, transactions, tokens, DEX trades, and more.',
  openGraph: {
    title: 'BNBScan — The Alternative BNB Chain Explorer',
    description: 'An open, independent BNB Chain explorer maintained by Measurable Data Token (MDT).',
    siteName: 'BNBScan by MDT',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-gray-50 text-gray-900 min-h-screen flex flex-col`}>
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  )
}
