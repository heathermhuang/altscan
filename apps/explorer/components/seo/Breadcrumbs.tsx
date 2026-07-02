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
      // Escape `<` so untrusted item names (e.g. token names from arbitrary
      // ERC-20 contracts) can't emit `</script>` and break out of this raw
      // script block. < is valid JSON and parsed identically by crawlers.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
    />
  )
}
