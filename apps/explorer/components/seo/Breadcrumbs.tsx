import { chainConfig } from '@/lib/chain'

type BreadcrumbItem = {
  name: string
  href?: string
}

export function BreadcrumbJsonLd({ items }: { items: BreadcrumbItem[] }) {
  const base = `https://${chainConfig.domain}`
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: base },
      ...items.map((item, i) => ({
        '@type': 'ListItem',
        position: i + 2,
        name: item.name,
        ...(item.href ? { item: `${base}${item.href}` } : {}),
      })),
    ],
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  )
}
