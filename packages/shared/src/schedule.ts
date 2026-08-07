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

/**
 * When to start *broadcasting*, which is not the same as when to start *watching*.
 *
 * Watching early is nearly free, so `EARLIEST_DELAY_BLOCKS` is deliberately pessimistic.
 * Broadcasting early is not free: every attempt sent before the flip can physically happen is
 * included, reverts, and is charged its full gas limit — while also consuming a nonce from a
 * finite pre-signed ladder.
 *
 * The smallest delay ever measured is 4,962 blocks, from four observations. Starting at 4,940
 * keeps ~22 blocks (~7 attempts at the default cadence) of margin against a flip earlier than
 * anything yet seen, while dropping the 40 blocks of guaranteed-wasted broadcasts that starting
 * at 4,900 would produce.
 *
 * The asymmetry still holds and still decides the constant: broadcasting 22 blocks early costs
 * a few attempts, broadcasting one block late can cost the position. If a flip is ever observed
 * below 4,962, lower this immediately and record it in FINDINGS.
 */
export const SPRAY_START_DELAY_BLOCKS = 4_940n;

export function sprayStartBlockFor(epoch: bigint): bigint {
  return boundaryBlockFor(epoch) + SPRAY_START_DELAY_BLOCKS;
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
  /** First block at which broadcasting can possibly land in the flip block. */
  sprayStart: bigint;
  /**
   * True once a broadcast could actually be the one sitting in the flip block. Before this,
   * attempts are guaranteed reverts: they cost gas and burn ladder rungs for nothing.
   */
  shouldBroadcast: boolean;
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
  const sprayStart = sprayStartBlockFor(targetEpoch);
  const secondsPerBlock = input.secondsPerBlock ?? 0.3;

  if (current.epoch >= targetEpoch) {
    return {
      phase: 'due', targetEpoch, boundaryBlock, earliestStart, latestStart, sprayStart,
      shouldBroadcast: true,
      blocksUntilBurst: 0n, pollIntervalMs: minPollMs,
      reason: `epoch ${current.epoch} has reached target ${targetEpoch} — fire now`,
    };
  }

  const blocksUntilBurst = earliestStart > currentBlock ? earliestStart - currentBlock : 0n;
  const shouldBroadcast = currentBlock >= sprayStart;

  if (currentBlock >= earliestStart) {
    return {
      phase: 'burst', targetEpoch, boundaryBlock, earliestStart, latestStart, sprayStart,
      shouldBroadcast,
      blocksUntilBurst: 0n, pollIntervalMs: minPollMs,
      reason:
        `inside the flip window (block ${currentBlock} of ${earliestStart}..${latestStart}) — ` +
        `the epoch can change on any block from here`,
    };
  }

  if (currentBlock >= boundaryBlock) {
    // Past the boundary block: changes are committed and the countdown is running. Poll often
    // enough to notice an unusually early flip, but there is still real time left.
    //
    // `shouldBroadcast` is false throughout this phase and stays false for the first 40 blocks
    // of `burst`, since sprayStart (+4,940) sits inside the burst window (+4,900). That gap is
    // the intended shape: watch pessimistically, spend optimistically.
    return {
      phase: 'approaching', targetEpoch, boundaryBlock, earliestStart, latestStart, sprayStart,
      shouldBroadcast,
      blocksUntilBurst, pollIntervalMs: Math.max(minPollMs, 2_000),
      reason:
        `boundary block passed; ${blocksUntilBurst} block(s) until the flip window ` +
        `(~${Math.round(Number(blocksUntilBurst) * secondsPerBlock)}s)`,
    };
  }

  const blocksToBoundary = boundaryBlock - currentBlock;
  return {
    phase: 'idle', targetEpoch, boundaryBlock, earliestStart, latestStart, sprayStart,
    shouldBroadcast,
    blocksUntilBurst, pollIntervalMs: Math.max(minPollMs, 30_000),
    reason:
      `${blocksToBoundary} block(s) to the boundary block ` +
      `(~${(Number(blocksToBoundary) * secondsPerBlock / 3600).toFixed(2)}h)`,
  };
}

/**
 * The block before which an `undelegate` must land to avoid losing a full epoch.
 *
 * Measured/documented behaviour: the snapshot for the next epoch is taken at the START of the
 * boundary block, before user transactions. So an undelegate that lands *before* the boundary
 * block activates at `n+1` and matures at `n+2`; one that lands in the boundary block or later
 * activates at `n+2` and matures at `n+3`.
 *
 * That difference is a whole epoch — about 4.2 hours at the measured cadence. In an emergency
 * it is the single largest lever available on the clock, and it is invisible unless you are
 * looking for it.
 */
export function undelegateDeadlineBlock(current: EpochState): bigint {
  // While inEpochDelayPeriod is false we are still before this epoch's boundary block and can
  // still make the earlier activation. Once true, the boundary has passed and the next chance
  // is the following epoch's boundary.
  const targetEpoch = current.inEpochDelayPeriod ? current.epoch + 2n : current.epoch + 1n;
  return boundaryBlockFor(targetEpoch);
}

export interface UndelegateTiming {
  /** Activation epoch if undelegating right now. */
  activationEpoch: bigint;
  /** Epoch at which the resulting withdrawal matures. */
  maturityEpoch: bigint;
  /** Land the undelegate strictly before this block to keep the earlier activation. */
  deadlineBlock: bigint;
  blocksRemaining: bigint;
  /** True when the boundary has already passed and an extra epoch is unavoidable. */
  missedThisBoundary: boolean;
}

/**
 * What undelegating right now would cost, and how long is left to beat the boundary.
 */
export function undelegateTiming(
  current: EpochState,
  currentBlock: bigint,
): UndelegateTiming {
  const activationEpoch = current.epoch + (current.inEpochDelayPeriod ? 2n : 1n);
  const deadlineBlock = undelegateDeadlineBlock(current);
  const blocksRemaining = deadlineBlock > currentBlock ? deadlineBlock - currentBlock : 0n;
  return {
    activationEpoch,
    maturityEpoch: activationEpoch + STAKING_CONSTANTS.WITHDRAWAL_DELAY,
    deadlineBlock,
    blocksRemaining,
    missedThisBoundary: current.inEpochDelayPeriod,
  };
}

/**
 * The epoch transition happens in the FIRST transaction of the flip block.
 *
 * Verified on testnet at block 50,554,962: transaction index 0 is
 * `syscallOnEpochChange(uint64)` (selector 0x1d4e9f02), which emits `EpochChanged`, followed by
 * `syscallReward` at index 1 and ordinary user transactions after that.
 *
 * The consequence is worth stating plainly: **a transaction in the flip block itself already
 * sees the new epoch.** The withdrawal is claimable within that block, so the flip block is the
 * target — not the block after it. Aiming one block late concedes 300ms and, more importantly,
 * a whole block of competing transactions.
 */
export const EPOCH_CHANGE_SYSCALL_SELECTOR = '0x1d4e9f02' as const;
export const FLIP_BLOCK_IS_CLAIMABLE = true;

/**
 * Rough wall-clock estimate for a number of epochs. Deliberately labelled an estimate: an
 * epoch is round-driven, and the observed testnet cadence (~0.30s/block, so ~4.2h per epoch)
 * is faster than the ~5.5h the documentation implies at 0.4s blocks. Never schedule against
 * this — it is for telling a human roughly when to come back.
 */
export function estimateEpochSeconds(secondsPerBlock = 0.3): number {
  return Number(STAKING_CONSTANTS.BOUNDARY_BLOCK_PERIOD) * secondsPerBlock;
}
