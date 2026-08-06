/**
 * Monad staking precompile — single source of truth.
 *
 * Address and selectors verified against Monad testnet (chainId 10143) on 2026-08-03:
 *   - eth_getCode(0x…1000) returns empty (it is a precompile, not a contract)
 *   - eth_call getEpoch() decoded to (epoch=1012, inEpochDelayPeriod=false)
 *   - eth_call getValidator(1) matched an independent validator API byte-for-byte
 * See research/FINDINGS.md for evidence.
 *
 * Do NOT duplicate this ABI anywhere else in the monorepo.
 */

export const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000' as const;

/**
 * Reserve-balance precompile (MIP-4). `dippedIntoReserve()` reports whether the
 * current transaction has dipped into the caller's reserve budget.
 * Must be invoked via CALL — STATICCALL/DELEGATECALL/CALLCODE revert.
 */
export const RESERVE_PRECOMPILE = '0x0000000000000000000000000000000000001001' as const;

/** Reserve balance enforced against EIP-7702-delegated EOAs. */
export const USER_RESERVE_BALANCE = 10_000_000_000_000_000_000n; // 10 MON

/** Protocol constants (docs.monad.xyz/reference/staking). */
export const STAKING_CONSTANTS = {
  /** Blocks between boundary blocks that commit staking changes (~5.5h). */
  BOUNDARY_BLOCK_PERIOD: 50_000n,
  /** Rounds of delay after the boundary block before the new epoch starts. */
  EPOCH_DELAY_ROUNDS: 5_000n,
  /** Epochs to wait after undelegate() before withdraw() succeeds. */
  WITHDRAWAL_DELAY: 1n,
  /** Minimum msg.value for delegate(). */
  DUST_THRESHOLD: 1_000_000_000n, // 1 gwei
  /** 100% commission, expressed as 1e18. */
  MAX_COMMISSION: 1_000_000_000_000_000_000n,
  /** Page size for the paginated view functions. */
  PAGINATED_RESULTS_SIZE: 100,
  /** Block reward pushed in via syscallReward(). */
  REWARD_PER_BLOCK: 18_000_000_000_000_000_000n, // 18 MON
} as const;

/**
 * IMonadStaking.
 *
 * Two constraints that differ from an ordinary contract and shape all call sites:
 *  1. Only CALL is allowed. STATICCALL / DELEGATECALL / CALLCODE revert. This is
 *     why every view function below is `nonpayable` rather than `view` — they
 *     cannot be reached via STATICCALL, which is what Solidity emits for `view`.
 *  2. Calls with invalid arguments consume ALL forwarded gas, so never forward
 *     an unbounded gas budget to a speculative call.
 *
 * Note for the rescue path: no fund-moving function takes a recipient address.
 * undelegate/withdraw/claimRewards all resolve the delegator from msg.sender and
 * pay out to msg.sender. See FINDINGS.md Q5.
 */
export const STAKING_ABI = [
  // ---- state-modifying ----
  {
    type: 'function',
    name: 'delegate',
    stateMutability: 'payable',
    inputs: [{ name: 'validatorId', type: 'uint64' }],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'undelegate',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorId', type: 'uint64' },
      { name: 'amount', type: 'uint256' },
      { name: 'withdrawId', type: 'uint8' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorId', type: 'uint64' },
      { name: 'withdrawId', type: 'uint8' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'claimRewards',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'validatorId', type: 'uint64' }],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'compound',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'validatorId', type: 'uint64' }],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'changeCommission',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorId', type: 'uint64' },
      { name: 'commission', type: 'uint256' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },

  // ---- views (nonpayable on purpose: STATICCALL reverts) ----
  {
    type: 'function',
    name: 'getEpoch',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [
      { name: 'epoch', type: 'uint64' },
      { name: 'inEpochDelayPeriod', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getValidator',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'validatorId', type: 'uint64' }],
    outputs: [
      { name: 'authAddress', type: 'address' },
      { name: 'flags', type: 'uint64' },
      { name: 'stake', type: 'uint256' },
      { name: 'accRewardPerToken', type: 'uint256' },
      { name: 'commission', type: 'uint256' },
      { name: 'unclaimedRewards', type: 'uint256' },
      { name: 'consensusStake', type: 'uint256' },
      { name: 'consensusCommission', type: 'uint256' },
      { name: 'snapshotStake', type: 'uint256' },
      { name: 'snapshotCommission', type: 'uint256' },
      { name: 'secpPubkey', type: 'bytes' },
      { name: 'blsPubkey', type: 'bytes' },
    ],
  },
  {
    type: 'function',
    name: 'getDelegator',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorId', type: 'uint64' },
      { name: 'delegator', type: 'address' },
    ],
    outputs: [
      { name: 'stake', type: 'uint256' },
      { name: 'accRewardPerToken', type: 'uint256' },
      { name: 'unclaimedRewards', type: 'uint256' },
      { name: 'deltaStake', type: 'uint256' },
      { name: 'nextDeltaStake', type: 'uint256' },
      { name: 'deltaEpoch', type: 'uint64' },
      { name: 'nextDeltaEpoch', type: 'uint64' },
    ],
  },
  {
    type: 'function',
    name: 'getWithdrawalRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorId', type: 'uint64' },
      { name: 'delegator', type: 'address' },
      { name: 'withdrawId', type: 'uint8' },
    ],
    outputs: [
      { name: 'withdrawalAmount', type: 'uint256' },
      { name: 'accRewardPerToken', type: 'uint256' },
      { name: 'withdrawEpoch', type: 'uint64' },
    ],
  },
  {
    type: 'function',
    name: 'getDelegations',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'delegator', type: 'address' },
      { name: 'startValId', type: 'uint64' },
    ],
    outputs: [
      { name: 'isDone', type: 'bool' },
      { name: 'nextValId', type: 'uint64' },
      { name: 'valIds', type: 'uint64[]' },
    ],
  },
  {
    type: 'function',
    name: 'getDelegators',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorId', type: 'uint64' },
      { name: 'startDelegator', type: 'address' },
    ],
    outputs: [
      { name: 'isDone', type: 'bool' },
      { name: 'nextDelegator', type: 'address' },
      { name: 'delegators', type: 'address[]' },
    ],
  },
  {
    type: 'function',
    name: 'getConsensusValidatorSet',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'startIndex', type: 'uint32' }],
    outputs: [
      { name: 'isDone', type: 'bool' },
      { name: 'nextIndex', type: 'uint32' },
      { name: 'valIds', type: 'uint64[]' },
    ],
  },

  // ---- events ----
  {
    type: 'event',
    name: 'Delegate',
    inputs: [
      { name: 'validatorId', type: 'uint64', indexed: true },
      { name: 'delegator', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'activationEpoch', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Undelegate',
    inputs: [
      { name: 'validatorId', type: 'uint64', indexed: true },
      { name: 'delegator', type: 'address', indexed: true },
      { name: 'withdrawId', type: 'uint8', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'activationEpoch', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      { name: 'validatorId', type: 'uint64', indexed: true },
      { name: 'delegator', type: 'address', indexed: true },
      { name: 'withdrawId', type: 'uint8', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'withdrawEpoch', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimRewards',
    inputs: [
      { name: 'validatorId', type: 'uint64', indexed: true },
      { name: 'delegator', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'epoch', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CommissionChanged',
    inputs: [
      { name: 'validatorId', type: 'uint64', indexed: true },
      { name: 'oldCommission', type: 'uint256', indexed: false },
      { name: 'newCommission', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ValidatorStatusChanged',
    inputs: [
      { name: 'validatorId', type: 'uint64', indexed: true },
      { name: 'flags', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'EpochChanged',
    inputs: [
      { name: 'oldEpoch', type: 'uint64', indexed: false },
      { name: 'newEpoch', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ValidatorRewarded',
    inputs: [
      { name: 'validatorId', type: 'uint64', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'epoch', type: 'uint64', indexed: false },
    ],
  },
] as const;

/**
 * Documented gas cost of each staking precompile function.
 *
 * These are large — `claimRewards` alone is more than twice a plain `withdraw` — and they are
 * what a rescue transaction's gas limit has to be sized against. A limit chosen for frugality
 * rather than measured against these will simply run out, and because the precompile consumes
 * all gas on failure there is no partial result to salvage.
 */
export const STAKING_GAS = {
  delegate: 260_850n,
  undelegate: 147_750n,
  withdraw: 68_675n,
  claimRewards: 155_375n,
  compound: 289_325n,
  getEpoch: 200n,
  getWithdrawalRequest: 24_300n,
} as const;

export interface RescueGasEstimate {
  gasLimit: bigint;
  perPosition: bigint;
  breakdown: string;
}

/**
 * Size a rescue transaction's gas limit from the work it actually does.
 *
 * A fixed default cannot work: the cost scales with the number of positions being claimed, and
 * an under-sized limit is not a partial rescue but a total loss of the attempt. Monad charges
 * the limit rather than the usage, so this is deliberately close to the real requirement with a
 * margin, not a round number chosen upward "to be safe".
 */
export function estimateRescueGas(positionCount: number, claimRewards: boolean): RescueGasEstimate {
  const n = BigInt(Math.max(1, positionCount));
  const perPosition = STAKING_GAS.withdraw + (claimRewards ? STAKING_GAS.claimRewards : 0n);
  const calls = n * perPosition;
  const baseTx = 21_000n;
  const calldata = 8_000n;      // arrays of validator ids and slots
  const contract = 15_000n * n; // loop, event emission, balance bookkeeping
  const sweep = 30_000n;        // native transfer plus the reserve-floor arithmetic
  const subtotal = baseTx + calldata + calls + contract + sweep;
  // 25% margin: the precompile consumes all gas on a failed call, so being short is fatal
  // while being long only costs the difference.
  const gasLimit = (subtotal * 125n) / 100n;
  return {
    gasLimit,
    perPosition,
    breakdown:
      `${positionCount} position(s) x ${perPosition} + base ${baseTx} + calldata ${calldata} + ` +
      `contract ${contract} + sweep ${sweep} = ${subtotal}, +25% margin -> ${gasLimit}`,
  };
}

/**
 * Whether claiming rewards is worth what it costs.
 *
 * `claimRewards` is 155,375 gas per position, more than twice a `withdraw`. Claiming 0.26 MON of
 * rewards across three positions costs about 1.1 MON in gas at a 20x fee multiplier — a net
 * loss. Rewards accrued *to the withdrawal itself* are paid by `withdraw()` regardless; this
 * only governs the separate delegator reward pot.
 */
export function rewardsWorthClaiming(
  unclaimedRewards: bigint,
  positionCount: number,
  gasPrice: bigint,
): boolean {
  const cost = STAKING_GAS.claimRewards * BigInt(Math.max(1, positionCount)) * gasPrice;
  return unclaimedRewards > cost;
}
