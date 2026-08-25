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
  /** Pre-signed bytes — used when there is no anti-revoke window to track. */
  raw?: `0x${string}`;
  /**
   * Just-in-time signer, used when an anti-revoke window IS loaded. It bakes in an authorization
   * slice matching the LIVE victim nonce. A sponsored attacker marches the victim nonce faster than
   * any startup-anchored pre-signed slice can track, so the slice must be chosen at the last
   * possible moment, not up front (Q29).
   *
   * The live nonce is read ONCE per cluster by spray and passed in here, not read per-attempt: the
   * K members of a cluster must tile a CONTIGUOUS `[liveNonce .. liveNonce + 4K-1]` span for the
   * SAME block, and they cannot if each re-reads a moving nonce (Q33 — independent reads plus a
   * blocking broadcast smeared the members across ~3 blocks, each covering a different, overlapping
   * range). This member applies its own fixed offset to the shared base. `liveNonce` is undefined
   * only when the read failed; the signer falls back to its startup floor then, so it never throws
   * and never strands a guardian nonce behind a gap. Exactly one of `raw` / `sign` is set.
   */
  sign?: (liveVictimNonce: number | undefined) => Promise<`0x${string}`>;
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
   * Multi-tx cluster size. The attempts array is laid out as consecutive groups of `clusterSize`
   * transactions that share a fee step and target the SAME flip block, differing only in which
   * live-nonce authorization slice they re-assert (Q32). They must land together, so the
   * inter-attempt `intervalMs` sleep is applied once per cluster (after every `clusterSize`
   * broadcasts), not after every transaction — the members go back-to-back, then we pace to the
   * next block. Defaults to 1 (every attempt is its own slot: the original per-attempt pacing).
   */
  clusterSize?: number;
  /**
   * Stop once this many attempts are in flight without resolution. Monad caps an account's
   * total gas across inflight transactions (last 3 blocks) at min(10 MON, lagged balance), so
   * an unbounded spray throttles itself at exactly the wrong moment.
   */
  maxInFlight: number;
  /**
   * How long a broadcast attempt counts against `maxInFlight`. Monad's cap covers the last
   * 3 blocks, so this defaults to 3 blocks at the measured 0.301s.
   */
  inflightWindowMs?: number;
  /**
   * Reads the LIVE victim nonce. Called ONCE per cluster (not per attempt), and the result is
   * handed to every member's `sign` so they tile a contiguous authorization span for one block.
   * Undefined when there is no anti-revoke window (static `raw` attempts), in which case `sign` is
   * not used at all. Must not throw — a failed read returns undefined and the signer falls back.
   */
  readVictimNonce?: () => Promise<number | undefined>;
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
 *
 * Consecutive nonces make the back-off path load-bearing in a way it does not look. An earlier
 * version backed off with `continue` inside a `for…of`, which advances the iterator — so hitting
 * the inflight cap **skipped** an attempt rather than delaying it. Skipping nonce N while later
 * sending N+1 leaves a gap, and a transaction behind a nonce gap cannot execute at all. The
 * back-off meant to protect the window would instead have stranded every remaining rung of the
 * ladder, silently, at the moment of the flip. Back-off must delay, never discard.
 */
export async function spray(p: SprayParams): Promise<SprayResult> {
  const timeline: SprayResult['timeline'] = [];
  let sent = 0;
  // Monad's inflight gas cap counts transactions from the last 3 blocks, so "inflight" decays
  // with time rather than on receipt. Track send times and expire them on the same window the
  // chain uses; the previous counter only ever decremented when we backed off, so it drifted
  // upward and throttled the spray harder the longer it ran.
  const sentAt: number[] = [];
  const inflightWindowMs = p.inflightWindowMs ?? 3 * 301;
  const clusterSize = Math.max(1, p.clusterSize ?? 1);

  for (let i = 0; i < p.attempts.length; ) {
    if (await p.isDone()) {
      return { succeeded: true, attemptsSent: sent, timeline };
    }

    const now = Date.now();
    while (sentAt.length > 0 && now - sentAt[0]! > inflightWindowMs) sentAt.shift();

    // The cluster is the in-flight UNIT: its members must share one flip block, so admit it only
    // when the whole cluster fits under the cap. The `sentAt.length > 0` guard keeps this from
    // deadlocking if a cluster is larger than the cap (e.g. escalation fees shrink the inflight
    // budget below clusterSize) — with nothing in flight we always admit at least one cluster and
    // let the chain queue any excess, rather than sleeping forever. With clusterSize 1 this is the
    // original per-attempt gate.
    if (sentAt.length > 0 && sentAt.length + clusterSize > p.maxInFlight) {
      // Wait rather than pile on: exceeding the per-account inflight gas budget would have our
      // own transactions rejected during the window we care most about. `i` does not advance —
      // this cluster is delayed, not dropped.
      await sleep(p.intervalMs);
      continue;
    }

    const batch = p.attempts.slice(i, i + clusterSize);
    // ONE live victim-nonce read for the whole cluster. Every member signs against this same base
    // plus its own offset, so they tile a contiguous span for the SAME block instead of each
    // re-reading a moving nonce — the Q33 fix. The read must not throw; on failure the signer falls
    // back to its startup floor.
    const liveNonce = p.readVictimNonce ? await p.readVictimNonce() : undefined;

    const t0 = Date.now();
    // Fire every member CONCURRENTLY. broadcastEverywhere returns on the first endpoint to accept
    // (~local round-trip, ~10ms) rather than blocking on the slow remotes, so the members reach the
    // mempool within a millisecond of each other and land in one flip block — the whole point of a
    // cluster. Serial awaits here (the old code) spaced them ~one block apart and lost the race.
    const fired = await Promise.all(
      batch.map(async (attempt) => {
        const raw = attempt.raw ?? (await attempt.sign!(liveNonce));
        const result = await broadcastEverywhere(p.chainId, raw, p.urls);
        return { attempt, hash: result.hash };
      }),
    );
    const ms = Date.now() - t0;
    for (const { attempt, hash } of fired) {
      sent++;
      sentAt.push(t0);
      timeline.push({ nonce: attempt.nonce, ms, hash });
      p.onAttempt?.(attempt.nonce, hash, ms);
    }
    i += batch.length;

    // One inter-block pace per cluster, not per member.
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
