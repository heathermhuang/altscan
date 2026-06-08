export interface Product {
  id: 'bnb' | 'eth';
  brand: string;        // "BNBScan"
  domain: string;       // "bnbscan.com"
  url: string;          // "https://bnbscan.com"
  healthUrl: string;    // "https://bnbscan.com/api/health"
  chain: string;        // "BNB Chain"
  logoLetter: string;   // "B"
  colorVar: string;     // CSS var name, "--bnb"
}

export const products: Product[] = [
  {
    id: 'bnb', brand: 'BNBScan', domain: 'bnbscan.com', url: 'https://bnbscan.com',
    healthUrl: 'https://bnbscan.com/api/health', chain: 'BNB Chain', logoLetter: 'B', colorVar: '--bnb',
  },
  {
    id: 'eth', brand: 'EthScan', domain: 'ethscan.io', url: 'https://ethscan.io',
    healthUrl: 'https://ethscan.io/api/health', chain: 'Ethereum', logoLetter: 'E', colorVar: '--eth',
  },
];
