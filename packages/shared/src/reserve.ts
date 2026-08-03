import { USER_RESERVE_BALANCE } from './staking.js';

/**
 * Monad reserve-balance rule (MIP-4) — the constraint no Ethereum rescue tool has.
 *
 * The rule as documented, restated precisely because the naive reading ("a
 * delegated EOA must always keep 10 MON") is wrong and would make us leave funds
 * behind:
 *
 *   At execution time, after execution but before gas refunds, the ending balance
 *   of a NON-SENDER account must not be lower than
 *       min(balance at transaction start, USER_RESERVE_BALANCE)
 *   For the SENDER, the ending balance may additionally be lower by at most the
 *   transaction's gas spend.
 *
 * Consequences that matter for the rescue path:
 *
 *  - The floor is min(startBalance, 10 MON), NOT a flat 10 MON. A compromised EOA
 *    that starts at 0 MON has a floor of 0, so a claim-then-sweep inside one
 *    transaction can move the entire withdrawn amount out. This is the common
 *    case for a drained wallet whose only remaining value is staked.
 *  - Only transactions that BOTH decrement the balance AND end below the floor
 *    revert. A transaction that leaves the balance unchanged or higher is always
 *    fine, even far below 10 MON.
 *  - A delegated EOA cannot use the "emptying exception". To empty below the
 *    floor the account must first undelegate, then wait k=3 blocks with no other
 *    transaction and no delegation/undelegation request for that account.
 *
 * In the rescue transaction the guardian is the sender and the victim EOA is a
 * non-sender account, so the non-sender rule is the one that binds.
 */

/** Blocks that must pass after undelegating before the emptying exception applies. */
export const EMPTYING_EXCEPTION_DELAY_BLOCKS = 3;

/**
 * The lowest balance a delegated non-sender account may end a transaction with.
 * Returns min(startBalance, 10 MON).
 */
export function reserveFloor(startBalance: bigint): bigint {
  return startBalance < USER_RESERVE_BALANCE ? startBalance : USER_RESERVE_BALANCE;
}

export interface SweepPlan {
  /** Balance of the EOA before the rescue transaction executes. */
  startBalance: bigint;
  /** Native MON credited to the EOA during the transaction (withdraw + claimed rewards). */
  inflow: bigint;
  /** Lowest permitted ending balance: min(startBalance, 10 MON). */
  floor: bigint;
  /** How much may be transferred to the safe address without reverting. */
  sweepable: bigint;
  /** MON that cannot be moved while the EOA remains delegated. */
  stranded: bigint;
  /** True when the reserve rule strands value that only undelegation can release. */
  requiresUndelegationToFullySweep: boolean;
}

/**
 * Compute how much a destination-locked sweep may move in a single transaction.
 *
 * `startBalance` is the EOA's balance before the transaction; `inflow` is what the
 * batch credits to it (withdrawn principal plus claimed rewards). Both in wei.
 */
export function planSweep(startBalance: bigint, inflow: bigint): SweepPlan {
  if (startBalance < 0n || inflow < 0n) {
    throw new Error('planSweep: balances must be non-negative');
  }
  const floor = reserveFloor(startBalance);
  const available = startBalance + inflow;
  const sweepable = available > floor ? available - floor : 0n;
  return {
    startBalance,
    inflow,
    floor,
    sweepable,
    stranded: floor,
    requiresUndelegationToFullySweep: floor > 0n,
  };
}

/**
 * Guard for the hot path: throws when a sweep amount would trip the reserve rule.
 * The briefing calls for failing loud near the floor rather than letting the
 * transaction revert on-chain and burn the rescue window.
 */
export function assertSweepAllowed(
  startBalance: bigint,
  inflow: bigint,
  sweepAmount: bigint,
): void {
  const plan = planSweep(startBalance, inflow);
  if (sweepAmount > plan.sweepable) {
    throw new Error(
      `reserve-balance violation: attempting to sweep ${sweepAmount} wei but only ` +
        `${plan.sweepable} wei is movable. The EOA started at ${startBalance} wei and ` +
        `must end at or above ${plan.floor} wei while delegated. Undelegate first ` +
        `(then wait ${EMPTYING_EXCEPTION_DELAY_BLOCKS} blocks with no other activity) ` +
        `to release the remaining ${plan.stranded} wei.`,
    );
  }
}
