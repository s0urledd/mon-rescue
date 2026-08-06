import type { PublicClient } from 'viem';
import { formatEther } from 'viem';

/**
 * Fee strategy expressed the way the operator actually thinks about it.
 *
 * `PRIORITY_FEE_MULTIPLIER` was the wrong abstraction. It multiplies whatever
 * `estimateFeesPerGas` returns, and on Monad `eth_maxPriorityFeePerGas` is a **hardcoded
 * 2 gwei** rather than a live recommendation — so the multiplier scaled a number that carries
 * no information about what anyone is actually bidding. "20x" meant nothing measurable.
 *
 * What the operator means is: *spend up to N MON per attempt, and outbid whatever is in the
 * block.* That is directly expressible. We sample what transactions are really paying, place
 * ourselves above the top of that distribution, and cap the result by a MON budget.
 *
 * Measured on mainnet: base fee pinned at the 100 gwei floor, most transactions bidding the
 * default 2 gwei tip, p90 around 102 gwei. Ordinary traffic is not the competition — the
 * attacker is, and against them this is an auction with no ceiling. The budget is what decides
 * where we stop, so it should be a number in MON, not a multiplier.
 */

export interface ObservedFees {
  baseFeePerGas: bigint;
  /** Highest priority fee seen in the sample. */
  maxPrioritySeen: bigint;
  p50Priority: bigint;
  p90Priority: bigint;
  sampled: number;
  blocks: number;
}

/**
 * Sample what transactions in recent blocks are actually bidding.
 *
 * Reads real transactions rather than asking the node for a recommendation, because the node's
 * recommendation on Monad is a constant.
 */
export async function observeFees(client: PublicClient, blocks = 5): Promise<ObservedFees> {
  const head = await client.getBlockNumber();
  const priorities: bigint[] = [];
  let baseFeePerGas = 100_000_000_000n; // documented floor

  for (let i = 0; i < blocks; i++) {
    try {
      const block = await client.getBlock({ blockNumber: head - BigInt(i), includeTransactions: true });
      if (block.baseFeePerGas && i === 0) baseFeePerGas = block.baseFeePerGas;
      for (const tx of block.transactions) {
        if (typeof tx === 'string') continue;
        if (tx.maxPriorityFeePerGas != null) priorities.push(tx.maxPriorityFeePerGas);
      }
    } catch {
      // A missing block must not abandon the sample.
    }
  }

  priorities.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const at = (q: number) =>
    priorities.length ? priorities[Math.min(priorities.length - 1, Math.floor(q * priorities.length))]! : 0n;

  return {
    baseFeePerGas,
    maxPrioritySeen: priorities.length ? priorities[priorities.length - 1]! : 0n,
    p50Priority: at(0.5),
    p90Priority: at(0.9),
    sampled: priorities.length,
    blocks,
  };
}

export interface FeePlan {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  costPerAttempt: bigint;
  /** Multiple of the highest observed bid. */
  overtopBy: number;
  explanation: string;
}

/**
 * Turn "I will spend up to N MON per attempt" into concrete fee parameters.
 *
 * The priority fee is set to dominate the observed distribution, then the whole thing is capped
 * so a single attempt cannot exceed the budget. Capping at the end rather than the start means
 * a quiet chain gets a huge overbid for free, and a contested one gets exactly what was
 * authorised — which is the behaviour the operator asked for.
 */
export function planFee(
  observed: ObservedFees,
  gasLimit: bigint,
  maxSpendPerAttempt: bigint,
  minOvertop = BigInt(process.env.FEE_OVERTOP ?? 10),
): FeePlan {
  // Sit well above the top of what anyone is currently paying, not above an average.
  const target = observed.maxPrioritySeen > 0n
    ? observed.maxPrioritySeen * minOvertop
    : observed.baseFeePerGas * minOvertop;

  // What the budget allows, once the base fee is paid.
  const affordableTotal = maxSpendPerAttempt / gasLimit;
  const affordablePriority = affordableTotal > observed.baseFeePerGas
    ? affordableTotal - observed.baseFeePerGas
    : 0n;

  const maxPriorityFeePerGas = target < affordablePriority ? target : affordablePriority;
  // maxFee covers base-fee movement between signing and inclusion; we are charged the actual
  // base plus our tip, not this ceiling.
  const maxFeePerGas = observed.baseFeePerGas * 3n + maxPriorityFeePerGas;
  const costPerAttempt = gasLimit * (observed.baseFeePerGas + maxPriorityFeePerGas);

  const overtopBy = observed.maxPrioritySeen > 0n
    ? Number((maxPriorityFeePerGas * 100n) / observed.maxPrioritySeen) / 100
    : Infinity;

  const budgetBound = target >= affordablePriority;

  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
    costPerAttempt,
    overtopBy,
    explanation:
      `base ${observed.baseFeePerGas / 1_000_000_000n} gwei, highest observed tip ` +
      `${observed.maxPrioritySeen / 1_000_000_000n} gwei over ${observed.sampled} txs; ` +
      `bidding ${maxPriorityFeePerGas / 1_000_000_000n} gwei tip ` +
      `(${overtopBy === Infinity ? 'no competing bids' : `${overtopBy.toFixed(1)}x the top bid`}), ` +
      `${formatEther(costPerAttempt)} MON per attempt` +
      (budgetBound ? ' — capped by the per-attempt budget' : ''),
  };
}

/**
 * `MAX_SPEND_PER_ATTEMPT_MON`, default 5 MON.
 *
 * This is the number that decides a contested rescue. Observed on mainnet: base pinned at the
 * 100 gwei floor, median tip 2 gwei, but the top bid across 69 transactions was **1,482 gwei**.
 * Beating the median is free; beating the top bidder is not, and the attacker is a top bidder
 * by construction. At 5 MON per attempt against a 330k-gas rescue we bid ~14,800 gwei — ten
 * times the highest bid observed — for about 4.9 MON.
 */
export function maxSpendPerAttemptFromEnv(): bigint {
  const raw = process.env.MAX_SPEND_PER_ATTEMPT_MON ?? '5';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`MAX_SPEND_PER_ATTEMPT_MON must be a positive number of MON, got "${raw}"`);
  }
  return BigInt(Math.round(parsed * 1e6)) * 10n ** 12n;
}
