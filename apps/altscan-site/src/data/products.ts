import { CHAINS } from '@altscan/chain-config';

export interface Product {
  id: 'bnb' | 'eth';
  brand: string;        // "BNBScan"
  domain: string;       // "bnbscan.com"
  url: string;          // "https://bnbscan.com"
  chain: string;        // "BNB Chain"
  logoLetter: string;   // "B"
  /** Newest blocks fetched per poll, in pages of up to 50 (the explorer's max). Enough to fill a
   *  wide tape on first load: BNB runs ~0.45s/block, so 150 blocks ≈ 67s (a 1920px tape plus the replay delay); ETH 16 ≈ 3 minutes. */
  tapeBlocks: number;
  /** Seconds of history drawn in the explorer panel's mini tape, at every width. The panels are
   *  always the same width, so equal windows give them one time scale, like the hero. 30s is the
   *  most a 320px phone can show before BNB's ~0.45s blocks drop under a pixel. */
  miniWindowS: number;
}

// Brand, domain and chain name come from chain-config, which owns them; the rest is this site's.
const fromChain = (id: Product['id']) => {
  const c = CHAINS[id];
  return { id, brand: c.brandName, domain: c.domain, url: `https://${c.domain}`, chain: c.name };
};

export const products: Product[] = [
  { ...fromChain('bnb'), logoLetter: 'B', tapeBlocks: 150, miniWindowS: 30 },
  { ...fromChain('eth'), logoLetter: 'E', tapeBlocks: 16, miniWindowS: 30 },
];
