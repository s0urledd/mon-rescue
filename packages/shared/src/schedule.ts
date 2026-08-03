import { STAKING_CONSTANTS } from './staking.js';
import type { EpochState } from './epoch.js';

/**
 * Epoch scheduling — when to wake up and when to start burst-polling.
 *
 * The staking reference warns: "A round is not a block — rounds increment even on missed
 * proposals. You cannot calculate epoch boundaries with modular arithmetic on block numbers."
 * That is true about the exact block, and it led an earlier version of this code to poll
 * blindly for hours. Measurement shows the warning is narrower than it sounds.
 *
 * Measured on Monad testnet (two independent archive nodes agreeing):
 *
 *   epoch 1009  boundary 50,400,000  started 50,404,999  (+4,999)
 *   epoch 1010  boundary 50,450,000  started 50,454,999  (+4,999)
 *   epoch 1011  boundary 50,500,000  started 50,504,999  (+4,999)
 *   epoch 1012  boundary 50,550,000  started 50,554,962  (+4,962)
 *
 * Two facts fall out:
 *
 *  1. The boundary block is EXACTLY (epoch - 1) * BOUNDARY_BLOCK_PERIOD. That is plain
 *     arithmetic on block height, and it is deterministic.
 *  2. The epoch then starts within EPOCH_DELAY_ROUNDS of that boundary. Rounds advance at
 *     least as fast as blocks (a missed proposal burns a round without producing a block), so
 *     the delay in BLOCKS is bounded above by 5,000 and can only be smaller.
 *
 * So the unlock is predictable to within ~40 blocks — about 12 seconds at the observed
 * ~0.3s cadence. That is the difference between polling for four hours and polling hard for
 * thirty seconds, and it lets the hot path be maximally aggressive exactly when it matters.
 */

/** Deterministic: the block that commits staking changes for `epoch`. */
export function boundaryBlockFor(epoch: bigint): bigint {
  return (epoch - 1n) * STAKING_CONSTANTS.BOUNDARY_BLOCK_PERIOD;
}

/**
 * Earliest block at which `epoch` can possibly begin.
 *
 * Conservative: the smallest measured delay was 4,962 blocks, so we start watching a little
 * before that. Being early costs a few seconds of polling; being late costs the rescue.
 */
export const EARLIEST_DELAY_BLOCKS = 4_900n;

/** Latest block by which `epoch` must have begun: the delay cannot exceed the round count. */
export function latestStartBlockFor(epoch: bigint): bigint {
  return boundaryBlockFor(epoch) + STAKING_CONSTANTS.EPOCH_DELAY_ROUNDS;
}

export function earliestStartBlockFor(epoch: bigint): bigint {
  return boundaryBlockFor(epoch) + EARLIEST_DELAY_BLOCKS;
}

export type Phase =
  | 'idle'          // far from the target; sleep cheaply
  | 'approaching'   // boundary block passed, epoch not yet due; poll moderately
  | 'burst'         // inside the window where the epoch can flip; poll as fast as allowed
  | 'due';          // target epoch reached or passed

export interface ScheduleAdvice {
  phase: Phase;
  targetEpoch: bigint;
  boundaryBlock: bigint;
  earliestStart: bigint;
  latestStart: bigint;
  blocksUntilBurst: bigint;
  /** Suggested poll interval for this phase, in milliseconds. */
  pollIntervalMs: number;
  reason: string;
}

export interface ScheduleInput {
  current: EpochState;
  currentBlock: bigint;
  targetEpoch: bigint;
  /** Floor from the latency benchmark: polling faster than the round-trip cannot help. */
  minPollMs: number;
  /** Observed seconds per block, for the human-readable estimate. */
  secondsPerBlock?: number;
}

/**
 * Decide how hard to poll right now.
 *
 * Idle polling is deliberately slow. The account is not going anywhere for hours, and a tight
 * loop over that span just burns rate limit that we will want later — public endpoints
 * throttle eth_call harder than block reads.
 */
export function advise(input: ScheduleInput): ScheduleAdvice {
  const { current, currentBlock, targetEpoch, minPollMs } = input;
  const boundaryBlock = boundaryBlockFor(targetEpoch);
  const earliestStart = earliestStartBlockFor(targetEpoch);
  const latestStart = latestStartBlockFor(targetEpoch);
  const secondsPerBlock = input.secondsPerBlock ?? 0.3;

  if (current.epoch >= targetEpoch) {
    return {
      phase: 'due', targetEpoch, boundaryBlock, earliestStart, latestStart,
      blocksUntilBurst: 0n, pollIntervalMs: minPollMs,
      reason: `epoch ${current.epoch} has reached target ${targetEpoch} — fire now`,
    };
  }

  const blocksUntilBurst = earliestStart > currentBlock ? earliestStart - currentBlock : 0n;

  if (currentBlock >= earliestStart) {
    return {
      phase: 'burst', targetEpoch, boundaryBlock, earliestStart, latestStart,
      blocksUntilBurst: 0n, pollIntervalMs: minPollMs,
      reason:
        `inside the flip window (block ${currentBlock} of ${earliestStart}..${latestStart}) — ` +
        `the epoch can change on any block from here`,
    };
  }

  if (currentBlock >= boundaryBlock) {
    // Past the boundary block: changes are committed and the countdown is running. Poll often
    // enough to notice an unusually early flip, but there is still real time left.
    return {
      phase: 'approaching', targetEpoch, boundaryBlock, earliestStart, latestStart,
      blocksUntilBurst, pollIntervalMs: Math.max(minPollMs, 2_000),
      reason:
        `boundary block passed; ${blocksUntilBurst} block(s) until the flip window ` +
        `(~${Math.round(Number(blocksUntilBurst) * secondsPerBlock)}s)`,
    };
  }

  const blocksToBoundary = boundaryBlock - currentBlock;
  return {
    phase: 'idle', targetEpoch, boundaryBlock, earliestStart, latestStart,
    blocksUntilBurst, pollIntervalMs: Math.max(minPollMs, 30_000),
    reason:
      `${blocksToBoundary} block(s) to the boundary block ` +
      `(~${(Number(blocksToBoundary) * secondsPerBlock / 3600).toFixed(2)}h)`,
  };
}

/**
 * Rough wall-clock estimate for a number of epochs. Deliberately labelled an estimate: an
 * epoch is round-driven, and the observed testnet cadence (~0.30s/block, so ~4.2h per epoch)
 * is faster than the ~5.5h the documentation implies at 0.4s blocks. Never schedule against
 * this — it is for telling a human roughly when to come back.
 */
export function estimateEpochSeconds(secondsPerBlock = 0.3): number {
  return Number(STAKING_CONSTANTS.BOUNDARY_BLOCK_PERIOD) * secondsPerBlock;
}
