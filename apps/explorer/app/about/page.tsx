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
    <div className="max-w-7xl mx-auto px-4 py-10 *:max-w-3xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <BreadcrumbJsonLd items={[{ name: 'About' }]} />
      {/* About section */}
      <p className="k">{'// '}about</p>
      <h1 className="mb-4 mt-2 text-[clamp(26px,3.4vw,40px)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">About {chainConfig.brandDomain}</h1>
      <p className="mb-3 leading-relaxed text-ink2">
        {chainConfig.brandDomain} is an independent, open-source block explorer for the{' '}
        <strong className="text-ink">{chainConfig.name}</strong> network, maintained by{' '}
        <a
          href="https://mdt.io"
          target="_blank"
          rel="noopener noreferrer"
          className="text-acc-ink underline hover:no-underline"
        >
          Measurable Data Token (MDT)
        </a>
        . We index new blocks as they arrive and keep recent history — transactions, token transfers,
        and smart-contract events — so you can explore recent on-chain activity.
      </p>
      <p className="mb-8 leading-relaxed text-ink2">
        Our goal is to provide a fast, reliable, and open-source alternative explorer that anyone can
        use — from casual users checking a transaction to developers building on{' '}
        {chainConfig.name}.
      </p>

      {/* Key features */}
      <h2 className="mb-3 text-lg font-semibold tracking-[-0.02em] text-ink">Key Features</h2>
      <ul className="mb-8 list-inside list-disc space-y-1.5 text-ink2 marker:text-mut">
        <li>Real-time block and transaction indexing</li>
        <li>Address portfolio view with token balances and transfer history</li>
        <li>Token analytics, top holders, and DEX trade tracking</li>
        <li>Validator and staking dashboard</li>
        <li>Free public REST API with interactive documentation</li>
        <li>Open-source codebase on GitHub</li>
      </ul>

      {/* FAQ */}
      <h2 className="mb-4 text-lg font-semibold tracking-[-0.02em] text-ink">Frequently Asked Questions</h2>
      <div className="mb-10 space-y-3">
        {faqs.map((faq, i) => (
          <details key={i} className="group rounded-xl border border-hair bg-card">
            <summary className="cursor-pointer select-none rounded-xl px-4 py-3 font-medium text-ink hover:bg-canvas">
              {faq.q}
            </summary>
            <p className="px-4 pb-3 leading-relaxed text-ink2">{faq.a}</p>
          </details>
        ))}
      </div>

      <p className="text-ink2">
        The code is on{' '}
        <a href="https://github.com/heathermhuang/altscan" target="_blank" rel="noopener noreferrer" className="text-acc-ink underline hover:no-underline">GitHub</a>{' '}
        under AGPL-3.0, and every endpoint is in the{' '}
        <Link href="/api-docs" className="text-acc-ink underline hover:no-underline">API reference</Link>.
      </p>
    </div>
  )
}
