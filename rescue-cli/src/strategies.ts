import type { PublicClient } from 'viem';
import { broadcastEverywhere } from './broadcast.js';

/**
 * Firing strategies, ranked by how fast they can possibly be.
 *
 * "Fast" here does not mean a faster RPC. It means being in front of the attacker at the one
 * block that matters. Ranked best to worst:
 *
 *  1. PRE-SUBMITTED SPRAY (this module). Do not detect anything. Pre-sign a sequence of
 *     identical rescue transactions at consecutive nonces and keep one in flight through the
 *     whole ~40-block uncertainty window, so a transaction is ALREADY QUEUED at the leader
 *     when the epoch flips. Reaction time is zero because there is no reaction. This is the
 *     fastest method that exists, and its cost is gas on the attempts that land too early.
 *
 *  2. EVENT-DRIVEN on a local node. Sub-millisecond notification, no polling. Requires running
 *     beside a Monad node.
 *
 *  3. IPC POLLING on a local node. ~1ms round-trip, no network.
 *
 *  4. REMOTE RPC POLLING. ~116ms measured against public endpoints — half a poll interval plus
 *     one round-trip. This is what a naive implementation does, and it is 100x slower than (1).
 *
 * Strategies 1 and 2-4 are complements, not alternatives. Run the spray as the primary and a
 * detector as the backstop: if the spray exhausts its nonces before the flip, the detector
 * still fires.
 *
 * Why spraying is safe. An attempt that executes before the funds mature reverts: withdraw()
 * fails, nothing is credited, and _sweep reverts with NothingToSweep. A revert rolls back all
 * state, so the withdrawal request is left completely intact and can be claimed by the next
 * attempt. The only cost of a premature attempt is gas. Note this relies on Monad including
 * failed transactions and charging for them — a proposer cannot see current state, so
 * transactions that will revert are still included.
 */

export interface SprayAttempt {
  nonce: number;
  raw: `0x${string}`;
}

export interface SprayParams {
  chainId: number;
  client: PublicClient;
  /** Pre-signed attempts, ascending by nonce. Identical calldata; only the nonce differs. */
  attempts: readonly SprayAttempt[];
  urls: readonly string[];
  /** Send at most one attempt per this many milliseconds. */
  intervalMs: number;
  /**
   * Stop once this many attempts are in flight without resolution. Monad caps an account's
   * total gas across inflight transactions (last 3 blocks) at min(10 MON, lagged balance), so
   * an unbounded spray throttles itself at exactly the wrong moment.
   */
  maxInFlight: number;
  /** Called with each broadcast result so the caller can log a timeline. */
  onAttempt?: (nonce: number, hash: `0x${string}` | undefined, ms: number) => void;
  /** Returns true once the rescue has demonstrably succeeded, ending the spray. */
  isDone: () => Promise<boolean>;
}

export interface SprayResult {
  succeeded: boolean;
  attemptsSent: number;
  winningHash?: `0x${string}`;
  timeline: { nonce: number; ms: number; hash?: string }[];
}

/**
 * Keep a rescue transaction in flight across the uncertainty window.
 *
 * Each attempt carries its own nonce, so an attempt that reverts consumes only that nonce and
 * the next one is unaffected. They are not fee replacements of one another — that is the fee
 * ladder in escalate.ts, which shares ONE nonce so at most one rung can land.
 */
export async function spray(p: SprayParams): Promise<SprayResult> {
  const timeline: SprayResult['timeline'] = [];
  let sent = 0;
  let inFlight = 0;

  for (const attempt of p.attempts) {
    if (await p.isDone()) {
      return { succeeded: true, attemptsSent: sent, timeline };
    }

    if (inFlight >= p.maxInFlight) {
      // Back off rather than pile on: exceeding the per-account inflight gas budget would
      // have our own transactions rejected during the window we care most about.
      await sleep(p.intervalMs);
      inFlight = Math.max(0, inFlight - 1);
      continue;
    }

    const t0 = Date.now();
    const result = await broadcastEverywhere(p.chainId, attempt.raw, p.urls);
    const ms = Date.now() - t0;
    sent++;
    inFlight++;
    timeline.push({ nonce: attempt.nonce, ms, hash: result.hash });
    p.onAttempt?.(attempt.nonce, result.hash, ms);

    await sleep(p.intervalMs);
  }

  const succeeded = await p.isDone();
  return { succeeded, attemptsSent: sent, timeline };
}

/**
 * How many attempts are needed to cover the flip window.
 *
 * The window is bounded: the epoch begins between 4,900 and 5,000 blocks after the boundary
 * block, so roughly 100 blocks of genuine uncertainty. One attempt every `blocksPerAttempt`
 * blocks covers it.
 */
export function attemptsNeeded(windowBlocks = 100, blocksPerAttempt = 3): number {
  return Math.ceil(windowBlocks / blocksPerAttempt) + 2; // +2 so the tail is covered
}

/**
 * Has the rescue landed? Checks the safe address balance rather than a transaction receipt,
 * because ANY of the redundant agents may have been the one that won — including one we do
 * not control. The trigger is permissionless by design, so "did it work" cannot be answered
 * by looking only at our own transactions.
 */
export function makeSafeBalanceChecker(
  client: PublicClient,
  safeAddress: `0x${string}`,
  baseline: bigint,
  minDelta: bigint,
): () => Promise<boolean> {
  return async () => {
    try {
      const balance = await client.getBalance({ address: safeAddress });
      return balance - baseline >= minDelta;
    } catch {
      return false; // a failed read is not evidence of success
    }
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
