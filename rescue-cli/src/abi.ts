/** MonRescue contract ABI, kept in sync with contracts/src/MonRescue.sol. */
export const MONRESCUE_ABI = [
  {
    type: 'function',
    name: 'rescue',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorIds', type: 'uint64[]' },
      { name: 'withdrawIds', type: 'uint8[]' },
      { name: 'claimRewardsToo', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sweep',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sweepableAmount',
    stateMutability: 'view',
    inputs: [{ name: 'startingBalance', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'SAFE_ADDRESS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'GUARDIAN',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'Rescued',
    inputs: [
      { name: 'safeAddress', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'validatorCount', type: 'uint256', indexed: false },
    ],
  },
] as const;
