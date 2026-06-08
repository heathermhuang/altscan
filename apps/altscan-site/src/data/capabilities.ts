export interface Capability { n: string; title: string; desc: string; }

export const capabilities: Capability[] = [
  { n: '01', title: 'Blocks & Txns', desc: 'Latest blocks, full tx detail, internal calls & logs.' },
  { n: '02', title: 'Addresses', desc: 'Balances, history, token holdings & NFTs.' },
  { n: '03', title: 'Tokens', desc: 'ERC-20 pages, holders, transfers, price data.' },
  { n: '04', title: 'DEX Trades', desc: 'Live PancakeSwap & Uniswap trade tracking.' },
  { n: '05', title: 'Whales', desc: 'Large transfers & top-holder analysis.' },
  { n: '06', title: 'Gas & Charts', desc: 'Live gas, historical network charts.' },
  { n: '07', title: 'Contracts', desc: 'Verify & read source via Sourcify.' },
  { n: '08', title: 'REST API', desc: 'v1 query API with keys & webhooks.' },
];
