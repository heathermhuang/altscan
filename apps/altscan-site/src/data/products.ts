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

export const products: Product[] = [
  {
    id: 'bnb', brand: 'BNBScan', domain: 'bnbscan.com', url: 'https://bnbscan.com',
    chain: 'BNB Chain', logoLetter: 'B', tapeBlocks: 150, miniWindowS: 30,
  },
  {
    id: 'eth', brand: 'EthScan', domain: 'ethscan.io', url: 'https://ethscan.io',
    chain: 'Ethereum', logoLetter: 'E', tapeBlocks: 16, miniWindowS: 30,
  },
];
