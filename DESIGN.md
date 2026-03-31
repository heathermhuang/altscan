# Design System — BNBScan / EthScan

## Product Context

- **What this is:** Open-source blockchain explorers for BNB Chain and Ethereum. Data-heavy web app — blocks, transactions, addresses, tokens, DEX trades, whale activity.
- **Who it's for:** Mixed audience — retail crypto users, developers, and power users / researchers. Both equally.
- **Space/industry:** Blockchain explorer. Primary peers: Etherscan, BscScan (dated, cluttered). Blockscout (open-source, went marketing-site-first).
- **Project type:** Data-heavy web app, dual-branded (BNBScan.com + EthScan.io) sharing one codebase.
- **Positioning:** The open-source community option — transparency and community over corporate. Crafted, not polished-startup.

## Aesthetic Direction

- **Direction:** Industrial Utility with Craft — data-dense AND visually intentional. Peers feel like 2017 government sites or purple-gradient startup marketing. We feel like a well-made developer tool. Think: Linear, a good CLI, a precision instrument.
- **Decoration level:** Minimal — typography and data do the work. No decorative blobs, gradients, or icon grids.
- **Mood:** Precise, honest, trustworthy. The kind of tool a software artisan would use. Never clinical, never flashy.
- **Research notes:** Etherscan/BscScan = frozen in 2017. Blockscout = purple gradient startup-ification. Solana Explorer = pure dark terminal, zero design decisions. Gap: nobody has built the explorer that's both data-dense and visually intentional.

## Typography

- **Display/Hero:** Plus Jakarta Sans — warm and confident without being flashy. Not overused. Feels grounded.
- **Body/UI labels:** Plus Jakarta Sans — consistent with display. Weight 400 (body), 500 (labels), 600–700 (headings, buttons).
- **ALL data values:** JetBrains Mono — this is the key design risk. Every data value uses mono: block numbers, transaction hashes, addresses, token balances, gas prices, timestamps. Not just code blocks. This is deliberate chain-explorer DNA.
- **Code:** JetBrains Mono (same as data — consistent, no switching)
- **Loading:** Google Fonts CDN. `?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500`

### Type Scale

| Role | Font | Size | Weight |
|------|------|------|--------|
| Page heading | Plus Jakarta Sans | 24px / 1.5rem | 700 |
| Section heading | Plus Jakarta Sans | 18px / 1.125rem | 700 |
| Card title | Plus Jakarta Sans | 13px | 700 |
| UI label | Plus Jakarta Sans | 13px | 500–600 |
| Body | Plus Jakarta Sans | 14px | 400 |
| Small / caption | Plus Jakarta Sans | 11–12px | 400–600 |
| Data value | JetBrains Mono | 12–13px | 400–500 |
| Stat number | JetBrains Mono | 18–22px | 500 |
| Hash / address | JetBrains Mono | 12px | 400 |

## Color

### Chain Accents

Two chains, one neutral system. The accent is the personality.

| Chain | Official Hex | Tailwind approx | Usage |
|-------|-------------|-----------------|-------|
| BNB Chain | `#F3BA2F` | `yellow-400` (#FACC15) | All accent uses |
| Ethereum | `#1E3A8A` | `blue-900` | All accent uses |

**Important:** `#F3BA2F` is the official BNB brand hex. The Tailwind `yellow-400` (#FACC15) is an approximation (~5% lighter). DESIGN.md canonizes the official hex; the Tailwind implementation approximates it. For pixel-perfect accuracy, use `bg-[#F3BA2F]` arbitrary values.

The ETH navy (`#1E3A8A`) has no strict official hex — `blue-900` is the established convention.

### Neutral Palette (shared by both chains)

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg` | `#F7F7F5` | Page background — warm off-white, not pure white |
| `--surface` | `#FFFFFF` | Cards, tables, nav |
| `--surface-2` | `#F0F0EE` | Table headers, secondary areas, hover states |
| `--border` | `#E4E4E0` | Primary borders |
| `--border-subtle` | `#EDEDEB` | Table row dividers |
| `--text-primary` | `#111110` | Main text |
| `--text-secondary` | `#6B6B67` | Secondary labels, descriptions |
| `--text-muted` | `#9B9B97` | Captions, placeholders |
| `--link` | `#4B6CB7` | Transaction hashes, address links, all clickable data |
| `--link-hover` | `#3355A0` | Link hover state |

**Key decision:** `#F7F7F5` for page background, not `#FFFFFF`. Borrowed from print — the paper behind the data matters. Slightly warm, never clinical.

### Semantic Colors

| Token | Hex | Tailwind | Usage |
|-------|-----|----------|-------|
| Success | `#1A7F4B` | `green-700` | Confirmed transactions, success badges |
| Success bg | `#F0FBF4` | `green-50` | Badge backgrounds |
| Error | `#C0392B` | `red-700` | Failed transactions, error states |
| Error bg | `#FEF2F0` | `red-50` | Error badge backgrounds |
| Warning | `#B45309` | `amber-700` | Pending, caution states |
| Warning bg | `#FFFBEB` | `amber-50` | Warning badge backgrounds |

### Dark Mode

Strategy: redesign surfaces, reduce accent saturation 10–15%. The warm neutral system inverts cleanly.

| Token | Light | Dark |
|-------|-------|------|
| `--bg` | `#F7F7F5` | `#111110` |
| `--surface` | `#FFFFFF` | `#1C1C1A` |
| `--surface-2` | `#F0F0EE` | `#242422` |
| `--border` | `#E4E4E0` | `#2E2E2C` |
| `--text-primary` | `#111110` | `#F5F5F3` |
| `--text-secondary` | `#6B6B67` | `#A0A09C` |
| `--link` | `#4B6CB7` | `#7B9FDD` |

## Spacing

- **Base unit:** 4px
- **Density:** Comfortable — slightly more air than Etherscan, never as loose as a marketing site
- **Scale:**

| Token | px | Tailwind |
|-------|----|----------|
| 2xs | 4px | `p-1` |
| xs | 8px | `p-2` |
| sm | 12px | `p-3` |
| md | 16px | `p-4` |
| lg | 24px | `p-6` |
| xl | 32px | `p-8` |
| 2xl | 48px | `p-12` |
| 3xl | 64px | `p-16` |

## Layout

- **Approach:** Grid-disciplined — strict columns for data pages. Clean max-width containers. No editorial asymmetry for data views.
- **Max content width:** 960px (`max-w-5xl`) for data pages; 1280px for full-width tables when needed
- **Grid:** 12-column conceptual grid; in practice: sidebar (240px) + main content for address/contract pages; full-width for block/tx lists

### Border Radius Scale

| Use case | Value | Tailwind |
|----------|-------|----------|
| Small elements (badges, chips) | 4px | `rounded` |
| Inputs, buttons | 8px | `rounded-lg` |
| Cards, table containers | 12px | `rounded-xl` |
| Pills, chain switcher | 9999px | `rounded-full` |

## Motion

- **Approach:** Minimal-functional — transitions only where they aid comprehension
- **Easing:** Enter: `ease-out` / Exit: `ease-in` / Move: `ease-in-out`
- **Duration scale:**
  - Micro (hover states, button press): 100–150ms
  - Short (panel open, dropdown): 150–200ms
  - Medium (page transitions if any): 250–350ms

No scroll-driven animations. No entrance choreography. Not that kind of product.

## Design Risks

These three decisions are where BNBScan gets its own face. They work together.

### 1. Monospace data throughout
Every data value uses JetBrains Mono — not just code/hashes. Block numbers, balances, gas prices, timestamps, table values. This is deliberate chain-explorer DNA. It gives data pages an editorial precision and signals "we take data seriously."

**What you gain:** Tabular number alignment in columns, clear visual distinction between UI chrome and data content, developer-tool credibility.
**What it costs:** Slightly larger font payload. Worth it.

### 2. Chain accent permeates deeper
The BNB yellow / ETH navy appears as:
- Left-border (3px) on stat cards
- Focus ring on search and form inputs
- Active state in navigation
- Primary button background

NOT just the header bar. The chain color becomes a personality trait threaded through the product, not a decorator slapped on the nav.

### 3. Off-white page background
`#F7F7F5` instead of `#FFFFFF`. Surfaces (cards, tables) stay white, which creates natural elevation — cards lift off the page without shadows. Borrowed from print design. Warm, never clinical.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-31 | Plus Jakarta Sans for UI, JetBrains Mono for all data | Industrial utility direction — mono data gives editorial precision |
| 2026-03-31 | #F3BA2F as canonical BNB yellow (Tailwind yellow-400 as approximation) | Official BNB brand hex documented; Tailwind approximates for practicality |
| 2026-03-31 | #F7F7F5 warm off-white for page background | Cards lift off naturally; warm neutral keeps it approachable |
| 2026-03-31 | #4B6CB7 blue-gray for links | Avoid pure blue (#0000FF vibes); blue-gray reads "clickable" without screaming |
| 2026-03-31 | Chain accent on left-border of stat cards, focus rings, active nav | Accent as personality thread, not just header decoration |
| 2026-03-31 | No dark mode as default | Explorer targets mixed audience; light default is more accessible and community-friendly |
