/** MonRescue contract ABI, kept in sync with contracts/src/MonRescue.sol. */
export const MONRESCUE_ABI = [
  // Errors first, and they are not decoration. Without them viem cannot decode a custom-error
  // revert and reports "Execution reverted for an unknown reason" — which makes NothingToSweep
  // (expected, benign) read identically to a real failure. The pre-arm simulation distinguishes
  // fatal from harmless by error name, so omitting these turns every check into a coin flip.
  { type: 'error', name: 'ZeroSafeAddress', inputs: [] },
  { type: 'error', name: 'SafeAddressIsPrecompile', inputs: [] },
  { type: 'error', name: 'LengthMismatch', inputs: [] },
  { type: 'error', name: 'SweepFailed', inputs: [] },
  { type: 'error', name: 'NothingToSweep', inputs: [] },
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
    name: 'startUnbonding',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorIds', type: 'uint64[]' },
      { name: 'withdrawId', type: 'uint8' },
    ],
    outputs: [{ name: 'started', type: 'uint256' }],
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
  {
    type: 'event',
    name: 'UnbondStarted',
    inputs: [
      { name: 'validatorId', type: 'uint64', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'withdrawId', type: 'uint8', indexed: false },
    ],
  },
] as const;
