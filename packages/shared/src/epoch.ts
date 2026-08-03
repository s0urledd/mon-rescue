import { STAKING_CONSTANTS } from './staking.js';

/**
 * Epoch and unbonding timing.
 *
 * The single most important fact here: you CANNOT compute an unlock block number.
 * Monad advances epochs by rounds, and rounds increment even on missed proposals,
 * so modular arithmetic on block numbers does not locate an epoch boundary. The
 * only reliable source is getEpoch() on the staking precompile (or the
 * EpochChanged event).
 *
 * That kills the "pre-stage a transaction for a known unlock block" design the
 * briefing assumed. The hot path must poll getEpoch() and fire on the epoch
 * transition instead. See FINDINGS.md Q6.
 */

export interface EpochState {
  epoch: bigint;
  /** True once the boundary block has passed and changes are committing. */
  inEpochDelayPeriod: boolean;
}

/**
 * The epoch in which stake undelegated *now* becomes withdrawable.
 *
 * Per the staking reference, for an undelegate request made in epoch n:
 *   - epoch n + 1 + WITHDRAWAL_DELAY when the request is before the boundary block
 *   - epoch n + 2 + WITHDRAWAL_DELAY otherwise
 * `inEpochDelayPeriod` is exactly the "past the boundary block" signal.
 */
export function withdrawableAtEpoch(state: EpochState): bigint {
  const offset = state.inEpochDelayPeriod ? 2n : 1n;
  return state.epoch + offset + STAKING_CONSTANTS.WITHDRAWAL_DELAY;
}

/**
 * Whether a pending withdrawal request is claimable in the current epoch.
 * `withdrawEpoch` comes from getWithdrawalRequest().
 */
export function isClaimable(current: EpochState, withdrawEpoch: bigint): boolean {
  return current.epoch >= withdrawEpoch;
}

/**
 * Epochs remaining before a request becomes claimable. Zero means claimable now.
 * Deliberately returns epochs rather than seconds: an epoch is ~5.5 hours but is
 * round-driven, so any conversion to wall-clock time is an estimate, not a
 * deadline to schedule against.
 */
export function epochsUntilClaimable(current: EpochState, withdrawEpoch: bigint): bigint {
  const remaining = withdrawEpoch - current.epoch;
  return remaining > 0n ? remaining : 0n;
}
