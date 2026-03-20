export interface Block {
  number: number
  hash: string
  parentHash: string
  timestamp: Date
  miner: string
  gasUsed: bigint
  gasLimit: bigint
  baseFeePerGas: bigint | null
  txCount: number
  size: number
}

export interface Transaction {
  hash: string
  blockNumber: number
  fromAddress: string
  toAddress: string | null
  value: bigint
  gas: bigint
  gasPrice: bigint
  gasUsed: bigint
  input: string
  status: boolean
  methodId: string | null
  txIndex: number
  timestamp: Date
}

export interface TokenTransfer {
  id?: number
  txHash: string
  logIndex: number
  tokenAddress: string
  fromAddress: string
  toAddress: string
  value: bigint
  tokenId: bigint | null
  blockNumber: number
  timestamp: Date
}

export interface Token {
  address: string
  name: string
  symbol: string
  decimals: number
  type: 'BEP20' | 'BEP721' | 'BEP1155'
  totalSupply: bigint
  holderCount: number
  logoUrl: string | null
}

export interface DexTrade {
  id?: number
  txHash: string
  dex: string
  pairAddress: string
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
  maker: string
  blockNumber: number
  timestamp: Date
}

export interface Validator {
  address: string
  moniker: string
  votingPower: bigint
  commission: number
  uptime: number
  status: 'active' | 'inactive' | 'jailed'
  updatedAt: Date
}

export interface Contract {
  address: string
  bytecode: string
  abi: object[] | null
  sourceCode: string | null
  compilerVersion: string | null
  verifiedAt: Date | null
  verifySource: 'own' | 'sourcify' | null
  license: string | null
}

export interface GasStats {
  slow: bigint
  standard: bigint
  fast: bigint
  baseFee: bigint
  blockNumber: number
  timestamp: Date
}

export interface ChainStats {
  latestBlock: number
  tps: number
  avgBlockTime: number
  totalTransactions: number
  bnbPrice: number
  marketCap: number
}
