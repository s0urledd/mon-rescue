import { createWalletClient, http } from 'viem';
import type { Account, Chain } from 'viem';
import { broadcastEverywhere } from './broadcast.js';

/**
 * Pre-signed fee-escalation ladder.
 *
 * Monad leaders order transactions by descending fee-per-gas, so the ordering race is
 * ultimately an auction. Two things follow:
 *
 *  1. We should be willing to bid high. The rescued position is worth vastly more than any
 *     plausible fee, so being outbid is the expensive outcome, not overpaying.
 *  2. We cannot know the right bid in advance, because it depends on what the attacker bids.
 *
 * The answer is a ladder of transactions at increasing fees, all sharing ONE nonce, so each
 * replaces the last. They are all signed up front: signing inside the race would add
 * milliseconds at the exact moment they are most expensive, which is the same reason the
 * first transaction is pre-signed at arm time.
 *
 * Because they share a nonce, at most one can ever be included. There is no risk of paying
 * twice or of two rescues landing.
 */

export interface LadderStep {
  /** Multiple of the base fee estimate used for this rung. */
  multiplier: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  raw: `0x${string}`;
}

export interface BuildLadderParams {
  account: Account;
  chain: Chain;
  rpcUrl: string;
  to: `0x${string}`;
  data: `0x${string}`;
  nonce: number;
  gas: bigint;
  baseMaxFeePerGas: bigint;
  baseMaxPriorityFeePerGas: bigint;
  /** Fee multipliers, ascending. Defaults to a 5x..40x ladder. */
  multipliers?: readonly bigint[];
}

/**
 * Ladder rungs, ascending.
 *
 * IMPORTANT — start HIGH in a contested race. Leaders order by descending total gas price, so
 * once both our transaction and the attacker's are in the same leader's mempool, the block
 * position is decided by fee alone. Arriving 5ms earlier with a lower bid loses. Latency only
 * determines whether we make the cut for that proposal at all; the fee decides who goes first
 * inside it.
 *
 * The old default started at 5x and climbed, which is correct for a cost-sensitive
 * uncontested send and exactly wrong for a rescue. Losing costs the whole position; overpaying
 * costs a few MON.
 */
export const DEFAULT_MULTIPLIERS = [20n, 40n, 80n, 160n] as const;

/** For an uncontested send where cost matters more than winning. */
export const ECONOMY_MULTIPLIERS = [2n, 5n, 10n] as const;

export async function buildLadder(p: BuildLadderParams): Promise<LadderStep[]> {
  const multipliers = [...(p.multipliers ?? DEFAULT_MULTIPLIERS)].sort((a, b) => (a < b ? -1 : 1));
  const wallet = createWalletClient({ account: p.account, chain: p.chain, transport: http(p.rpcUrl) });

  const steps: LadderStep[] = [];
  for (const multiplier of multipliers) {
    const maxFeePerGas = p.baseMaxFeePerGas * multiplier;
    const maxPriorityFeePerGas = p.baseMaxPriorityFeePerGas * multiplier;
    const raw = await wallet.signTransaction({
      to: p.to,
      data: p.data,
      nonce: p.nonce, // identical across the ladder: each rung replaces the previous
      gas: p.gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      chain: p.chain,
    });
    steps.push({ multiplier, maxFeePerGas, maxPriorityFeePerGas, raw });
  }
  return steps;
}

export interface FireResult {
  hash?: `0x${string}`;
  includedAtRung?: number;
  rungsUsed: number;
  timeline: { rung: number; multiplier: string; ms: number; hash?: string; error?: string }[];
}

export interface FireParams {
  chainId: number;
  ladder: readonly LadderStep[];
  urls: readonly string[];
  /** Milliseconds to wait for inclusion before escalating to the next rung. */
  rungTimeoutMs: number;
  /** Resolves to a receipt-ish object once the hash lands, or null on timeout. */
  waitForInclusion: (hash: `0x${string}`, timeoutMs: number) => Promise<unknown | null>;
  log?: (msg: string) => void;
}

/**
 * Fire the ladder: broadcast the lowest rung everywhere, and escalate only if it has not landed
 * within `rungTimeoutMs`.
 *
 * With DEFAULT_MULTIPLIERS the "lowest" rung is already 20x, because in a contested race the
 * fee is what decides block position and being outbid loses the position outright. The ladder
 * exists to go higher still if even that is not enough, not to creep up from cheap.
 */
export async function fireLadder(p: FireParams): Promise<FireResult> {
  const timeline: FireResult['timeline'] = [];
  const log = p.log ?? (() => {});
  let lastHash: `0x${string}` | undefined;

  for (let i = 0; i < p.ladder.length; i++) {
    const step = p.ladder[i]!;
    const t0 = Date.now();
    log(`rung ${i} (${step.multiplier}x) broadcasting to ${p.urls.length} endpoint(s)`);

    const result = await broadcastEverywhere(p.chainId, step.raw, p.urls);
    const ms = Date.now() - t0;

    if (!result.hash) {
      const err = result.attempts.find((a) => a.error)?.error;
      timeline.push({ rung: i, multiplier: `${step.multiplier}x`, ms, error: err });
      log(`rung ${i} rejected by every endpoint: ${err}`);
      continue;
    }

    lastHash = result.hash;
    timeline.push({ rung: i, multiplier: `${step.multiplier}x`, ms, hash: result.hash });
    log(`rung ${i} accepted as ${result.hash} in ${ms}ms; waiting up to ${p.rungTimeoutMs}ms`);

    const included = await p.waitForInclusion(result.hash, p.rungTimeoutMs);
    if (included) {
      log(`rung ${i} included`);
      return { hash: result.hash, includedAtRung: i, rungsUsed: i + 1, timeline };
    }
    log(`rung ${i} not included in time — escalating`);
  }

  return { hash: lastHash, rungsUsed: p.ladder.length, timeline };
}
