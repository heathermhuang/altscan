/**
 * Decode well-known EVM event signatures from topic0 hashes.
 * Provides human-readable event names for common ERC-20, ERC-721,
 * DEX, and DeFi events without requiring a full ABI lookup.
 */

const KNOWN_EVENTS: Record<string, { name: string; params: string[] }> = {
  // ERC-20
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': {
    name: 'Transfer',
    params: ['from', 'to', 'value'],
  },
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': {
    name: 'Approval',
    params: ['owner', 'spender', 'value'],
  },

  // WETH / WBNB
  '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c': {
    name: 'Deposit',
    params: ['dst', 'wad'],
  },
  '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65': {
    name: 'Withdrawal',
    params: ['src', 'wad'],
  },

  // Uniswap V2
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822': {
    name: 'Swap',
    params: ['sender', 'amount0In', 'amount1In', 'amount0Out', 'amount1Out', 'to'],
  },
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1': {
    name: 'Sync',
    params: ['reserve0', 'reserve1'],
  },
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f': {
    name: 'Mint',
    params: ['sender', 'amount0', 'amount1'],
  },
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496': {
    name: 'Burn',
    params: ['sender', 'amount0', 'amount1', 'to'],
  },

  // Uniswap V3
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67': {
    name: 'Swap',
    params: ['sender', 'recipient', 'amount0', 'amount1', 'sqrtPriceX96', 'liquidity', 'tick'],
  },
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde': {
    name: 'Mint',
    params: ['sender', 'owner', 'tickLower', 'tickUpper', 'amount', 'amount0', 'amount1'],
  },
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c': {
    name: 'Burn',
    params: ['owner', 'tickLower', 'tickUpper', 'amount', 'amount0', 'amount1'],
  },

  // PancakeSwap V3
  '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3c6f6a0c': {
    name: 'Swap',
    params: ['sender', 'recipient', 'amount0', 'amount1', 'sqrtPriceX96', 'liquidity', 'tick'],
  },

  // ERC-721
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62': {
    name: 'TransferSingle',
    params: ['operator', 'from', 'to', 'id', 'value'],
  },
  '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb': {
    name: 'TransferBatch',
    params: ['operator', 'from', 'to', 'ids', 'values'],
  },

  // Governance
  '0xb8e138887d0aa13bab447e82de9d5c1777041ecd21ca36ba824ff1e6c07ddda4': {
    name: 'ProposalCreated',
    params: ['proposalId'],
  },
  '0x9a2a887706623ad7c8093a9ded3a1bf5edf3befe3e3cdf5e30df2bc3a2ab6c75': {
    name: 'VoteCast',
    params: ['voter', 'proposalId', 'support', 'weight', 'reason'],
  },

  // Aave / Lending
  '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61': {
    name: 'Supply',
    params: ['reserve', 'user', 'onBehalfOf', 'amount', 'referralCode'],
  },
  '0x3115d1449a7b732c986cba18244e897a145df0e3e44e30e965e1994e3bab9a50': {
    name: 'Borrow',
    params: ['reserve', 'user', 'onBehalfOf', 'amount', 'interestRateMode', 'borrowRate', 'referralCode'],
  },
}

export function decodeEventName(topic0: string | null): { name: string; params: string[] } | null {
  if (!topic0) return null
  return KNOWN_EVENTS[topic0.toLowerCase()] ?? null
}

function formatAddress(hex: string): string {
  return '0x' + hex.slice(-40).toLowerCase()
}

function formatUint(hex: string): string {
  try {
    const val = BigInt('0x' + hex.replace(/^0x/, ''))
    if (val > 10n ** 24n) {
      // Likely a token amount — show in scientific notation
      const str = val.toString()
      return str.length > 12 ? str.slice(0, 6) + '…' + str.slice(-4) : str
    }
    return val.toLocaleString()
  } catch {
    return hex
  }
}

export function decodeTopicParam(topic: string): string {
  // Topics are 32-byte hex values. If the first 12 bytes are zero, it's likely an address.
  const clean = topic.replace(/^0x/, '')
  if (clean.length === 64 && clean.startsWith('000000000000000000000000')) {
    return formatAddress(clean)
  }
  return formatUint(clean)
}
