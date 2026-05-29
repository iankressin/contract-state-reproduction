import type { JobConfig } from './src/config.ts'

/**
 * Example job: reproduce DAI state — exercising all three decoded shapes:
 *   - totalSupply : SCALAR uint256            (slot 1, no key source needed)
 *   - balanceOf   : mapping(address=>uint256) (slot 2, keys from Transfer)
 *   - allowance   : mapping(address=>mapping(address=>uint256)) (slot 3, keys from Approval)
 *
 * DAI was compiled with solc 0.5.12, which predates solc's `storageLayout` output (added
 * in 0.5.13) — so we pin each variable's `shape` (slot + key/value types) inline. For a
 * token built with solc >= 0.5.13 / 0.8.x, drop the `shape`s and `source` lets solc-auto
 * derive them (see VERIFY-2 / scripts/verify-layout.ts).
 */
const config: JobConfig = {
  id: 'dai-state',
  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
  deployBlock: 8_928_674,
  // toBlock: omitted => backfill to head, then follow live.

  source: { path: 'contracts/Dai.sol', contractName: 'Dai', solcVersion: '0.5.12' },

  trackedVariables: [
    {
      variable: 'totalSupply',
      shape: { slot: 1, valueType: 'uint256' },
    },
    {
      variable: 'balanceOf',
      shape: { slot: 2, keyTypes: ['address'], valueType: 'uint256' },
      keySources: [
        { eventAbi: 'event Transfer(address indexed src, address indexed dst, uint256 wad)', keyTuples: [['src'], ['dst']] },
      ],
    },
    {
      variable: 'allowance',
      shape: { slot: 3, keyTypes: ['address', 'address'], valueType: 'uint256' },
      keySources: [
        { eventAbi: 'event Approval(address indexed src, address indexed guy, uint256 wad)', keyTuples: [['src', 'guy']] },
      ],
    },
  ],
}

export default config
