import type { Metadata } from 'next'
import Link from 'next/link'
import { chainConfig } from '@/lib/chain'
import { BreadcrumbJsonLd } from '@/components/seo/Breadcrumbs'

export const metadata: Metadata = {
  title: 'About',
  description: `Learn about ${chainConfig.brandDomain}, an independent ${chainConfig.name} block explorer maintained by Measurable Data Token (MDT).`,
  alternates: { canonical: '/about' },
}

export const revalidate = 300

const faqs = [
  {
    q: `What is ${chainConfig.brandDomain}?`,
    a: `${chainConfig.brandDomain} is an open, independent block explorer for the ${chainConfig.name} network. It lets you search and inspect blocks, transactions, addresses, tokens, DEX trades, and more — all in real-time.`,
  },
  {
    q: 'Who maintains it?',
    a: `${chainConfig.brandDomain} is built and maintained by Measurable Data Token (MDT). MDT is a decentralized data exchange ecosystem that empowers users to monetize their data while ensuring privacy and security.`,
  },
  {
    q: 'Is it free to use?',
    a: `Yes — ${chainConfig.brandDomain} is completely free. We also provide a public REST API for developers to integrate ${chainConfig.name} data into their applications.`,
  },
  {
    q: `How is ${chainConfig.brandDomain} different from other explorers?`,
    a: `We focus on speed, simplicity, and transparency. Our codebase is open-source, we index data in real-time with our own infrastructure, and we don't require sign-ups or API keys for basic usage.`,
  },
  {
    q: 'How often is data updated?',
    a: `Our indexer processes new blocks within seconds of finalization. Most pages refresh automatically and show data that is less than a minute old.`,
  },
  {
    q: 'Do you support other networks?',
    a: `We currently operate explorers for BNB Chain (BNBScan.com) and Ethereum (EthScan.io), with the same open-source codebase powering both.`,
  },
  {
    q: 'How can I report a bug or request a feature?',
    a: `Open an issue on our GitHub repository or reach out via the MDT community channels. We welcome contributions and feedback.`,
  },
  {
    q: 'Is the code open-source?',
    a: `Yes. The full source code is available on GitHub. Contributions, bug reports, and pull requests are welcome.`,
  },
]

export default function AboutPage() {
  const { theme } = chainConfig

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: faq.a },
    })),
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <BreadcrumbJsonLd items={[{ name: 'About' }]} />
      {/* About section */}
      <h1 className="text-3xl font-bold mb-4">About {chainConfig.brandDomain}</h1>
      <p className="text-gray-600 mb-3 leading-relaxed">
        {chainConfig.brandDomain} is an independent, open-source block explorer for the{' '}
        <strong>{chainConfig.name}</strong> network, maintained by{' '}
        <a
          href="https://mdt.io"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline"
        >
          Measurable Data Token (MDT)
        </a>
        . We index every block, transaction, token transfer, and smart-contract event so you can
        explore on-chain activity in real-time.
      </p>
      <p className="text-gray-600 mb-8 leading-relaxed">
        Our goal is to provide a fast, reliable, and ad-free alternative explorer that anyone can
        use — from casual users checking a transaction to developers building on{' '}
        {chainConfig.name}.
      </p>

      {/* Key features */}
      <h2 className="text-xl font-semibold mb-3">Key Features</h2>
      <ul className="list-disc list-inside text-gray-600 mb-8 space-y-1.5">
        <li>Real-time block and transaction indexing</li>
        <li>Address portfolio view with token balances and transfer history</li>
        <li>Token analytics, top holders, and DEX trade tracking</li>
        <li>Gas tracker with historical gas price charts</li>
        <li>Validator and staking dashboard</li>
        <li>Free public REST API with interactive documentation</li>
        <li>Open-source codebase on GitHub</li>
      </ul>

      {/* FAQ */}
      <h2 className="text-xl font-semibold mb-4">Frequently Asked Questions</h2>
      <div className="space-y-5 mb-10">
        {faqs.map((faq, i) => (
          <details key={i} className="group border border-gray-200 rounded-lg">
            <summary className="cursor-pointer px-4 py-3 font-medium text-gray-900 hover:bg-gray-50 rounded-lg select-none">
              {faq.q}
            </summary>
            <p className="px-4 pb-3 text-gray-600 leading-relaxed">{faq.a}</p>
          </details>
        ))}
      </div>

      {/* Links */}
      <div className="flex flex-wrap gap-3 text-sm">
        <Link
          href="/"
          className={`${theme.buttonBg} ${theme.buttonText} px-4 py-2 rounded-lg font-medium hover:opacity-90 transition-opacity`}
        >
          Start Exploring
        </Link>
        <Link
          href="/api-docs"
          className="border border-gray-300 px-4 py-2 rounded-lg font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          API Documentation
        </Link>
        <a
          href="https://github.com/heathermhuang/bnbscan"
          target="_blank"
          rel="noopener noreferrer"
          className="border border-gray-300 px-4 py-2 rounded-lg font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          GitHub &rarr;
        </a>
      </div>
    </div>
  )
}
