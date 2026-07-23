import { AbiCoder, Interface } from 'ethers'
import { describe, expect, it } from 'vitest'
import { STAKE_HUB_ABI, toCommissionFraction } from './validator-stakehub'

const coder = AbiCoder.defaultAbiCoder()
const iface = () => new Interface(STAKE_HUB_ABI)

/**
 * All three expectations below were verified against the deployed StakeHub at
 * 0x…2002 on BSC mainnet (2026-07-22) before being written down.
 */
describe('StakeHub ABI — consensus→operator lookup', () => {
  it('exposes consensusToOperator, the accessor that actually exists on chain', () => {
    const fn = iface().getFunction('consensusToOperator')
    expect(fn).not.toBeNull()
    // selector observed returning a live operator address on mainnet
    expect(fn!.selector).toBe('0x86d54506')
  })

  it('does not reference getOperatorAddressByConsensusAddress, which reverts on chain', () => {
    // selector 0xcf06248c -> "execution reverted (no data present)" for every
    // validator, which is what produced "Resolved 0/53 operator addresses".
    expect(STAKE_HUB_ABI.join('\n')).not.toContain('getOperatorAddressByConsensusAddress')
  })
})

describe('StakeHub ABI — validator description', () => {
  it('decodes a struct-encoded Description return', () => {
    // The contract returns a single `Description` struct, not four flat strings.
    // A dynamic struct is encoded behind an extra offset word, so the flattened
    // signature fails to decode with BAD_DATA.
    const onChainShape = coder.encode(
      ['tuple(string,string,string,string)'],
      [['Legend', '0x0ccb', '', 'Low Commission. High APR %.']],
    )

    const decoded = iface().decodeFunctionResult('getValidatorDescription', onChainShape)

    expect(decoded[0].moniker).toBe('Legend')
  })
})

describe('commission scaling', () => {
  it('converts a StakeHub rate to the fraction the UI expects', () => {
    // Live mainnet rate for the first validator was 900 == 9.00%.
    // The UI renders parseFloat(commission) * 100.
    expect(toCommissionFraction(900n)).toBe('0.0900')
  })

  it('does not collapse a real commission to zero', () => {
    expect(toCommissionFraction(900n)).not.toBe('0.0000')
  })

  it('maps the full-rate bound to 1.0000 (fits numeric(5,4))', () => {
    expect(toCommissionFraction(10000n)).toBe('1.0000')
  })
})
