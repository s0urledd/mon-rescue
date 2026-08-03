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
 * The epoch at which a pending request actually becomes claimable.
 *
 * `withdrawEpoch`, as returned by getWithdrawalRequest(), is NOT the maturity epoch — it is
 * the epoch at which the undelegated stake *deactivates*, i.e. `n+1` or `n+2` relative to the
 * epoch the undelegate was submitted in. Maturity is one `WITHDRAWAL_DELAY` beyond that.
 *
 * The documentation is genuinely contradictory here: the WithdrawalRequest struct comment says
 * "Epoch when undelegate stake deactivates" while the undelegate pseudocode stores
 * `epoch = getEpoch()` (the current epoch). The struct comment is the correct one.
 *
 * Getting this wrong in either direction is costly. Treating `withdrawEpoch` as maturity fires
 * an epoch early and the call reverts with "withdrawal not ready" — and because an invalid
 * staking-precompile call consumes ALL gas in its frame, and Monad charges the gas limit
 * rather than gas used, that mistake is expensive as well as useless.
 */
export function maturityEpoch(withdrawEpoch: bigint): bigint {
  return withdrawEpoch + STAKING_CONSTANTS.WITHDRAWAL_DELAY;
}

/**
 * Whether a pending withdrawal request is claimable now.
 * `withdrawEpoch` comes from getWithdrawalRequest().
 */
export function isClaimable(current: EpochState, withdrawEpoch: bigint): boolean {
  return current.epoch >= maturityEpoch(withdrawEpoch);
}

/**
 * Epochs remaining before a request becomes claimable. Zero means claimable now.
 * Deliberately returns epochs rather than seconds: an epoch is round-driven, so any conversion
 * to wall-clock time is an estimate, never a deadline to schedule against.
 */
export function epochsUntilClaimable(current: EpochState, withdrawEpoch: bigint): bigint {
  const remaining = maturityEpoch(withdrawEpoch) - current.epoch;
  return remaining > 0n ? remaining : 0n;
}

/**
 * An empty withdrawal slot reads back as (0, 0, 0). A live request always carries a non-zero
 * epoch, because the stored value is at least `currentEpoch + 1`. So a zero `withdrawEpoch`
 * means "no request here", and getWithdrawalRequest is safe to probe with — unlike withdraw(),
 * which reverts with "unknown withdrawal id" on an empty slot.
 */
export function isEmptySlot(withdrawalAmount: bigint, withdrawEpoch: bigint): boolean {
  return withdrawalAmount === 0n && withdrawEpoch === 0n;
}
