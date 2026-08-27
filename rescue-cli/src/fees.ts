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

/**
 * The fee schedule across spray attempts: FLAT through the flip window, escalating only after.
 *
 * The previous version ramped cubically by attempt index, on the reasoning that most rescues
 * are uncontested so most attempts should be cheap. That reasoning does not survive contact
 * with how the window actually works.
 *
 * In `window` mode we broadcast across the ~40-block flip uncertainty, and **we do not know
 * which attempt will be the one sitting in the leader's mempool when the flip block is built.**
 * Any of them could be. So pricing them on a ramp means most of the candidates for the decisive
 * block are priced to lose — and the ones priced to win are the tail rungs, which only arrive if
 * the flip lands late. The ramp is not cheap-when-uncontested; it is a lottery over which fee we
 * happen to be bidding at the one block that matters.
 *
 * It also makes the battle test unmeasurable: "we won at an equal fee" means nothing if we
 * cannot say what we bid at the decisive block.
 *
 * So:
 *
 *  - **Window attempts are all priced the same**, at a fee comfortably above live traffic.
 *    Whichever one lands in the flip block, we bid the same thing. That is the controlled
 *    variable the test needs and the correct behaviour regardless.
 *  - **Escalation begins after the window**, where by construction the epoch has flipped
 *    (`latestStart` is an upper bound) and attempts are still failing. That is the first real
 *    evidence of a contest, as opposed to a counter running.
 *
 * The window fee is **well above the network average, not above its outlier**. Both extremes
 * were tried and both are wrong:
 *
 *  - Anchoring on the observed maximum: a single 1,482 gwei bid in a 69-transaction sample took
 *    the window to 93 MON. The window runs on every rescue, including the uncontested majority,
 *    so an outlier in the sample should not set the price of the common case.
 *  - Anchoring near the median: 2 gwei is what everyone sends by default, and matching it is
 *    not a bid.
 *
 * `p90 x WINDOW_FEE_OVERTOP` (default 15) sits hundreds of times above the median and puts a
 * full window in the **20-30 MON** band the operator has authorised as the standing default,
 * against observed mainnet traffic. Minimum gas is never the priority — the position is — but
 * the window is not where an unbounded bid belongs. Beating a genuine top bidder is what the
 * escalation rungs are for, and they only fire once the window has failed to settle it, which
 * is the first actual evidence that someone is racing.
 *
 * Every rung is signed up front, so none of this costs anything in the hot path.
 *
 * Note these use CONSECUTIVE nonces, not a shared one. Same-nonce replacement is undocumented
 * on Monad (see FINDINGS), so relying on it to supersede a cheaper attempt would be building on
 * an assumption. Independent nonces mean a landed early attempt simply ends the sequence.
 */
export function feeSchedule(
  observed: ObservedFees,
  gasLimit: bigint,
  maxSpendPerAttempt: bigint,
  attempts: number,
  /**
   * How many leading attempts cover the flip window and are therefore priced flat. Defaults to
   * all of them: with no window information, every attempt is a candidate for the decisive
   * block and none should be priced to lose.
   */
  windowAttempts = attempts,
  windowOvertop = BigInt(process.env.WINDOW_FEE_OVERTOP ?? 15),
): FeePlan[] {
  if (attempts <= 0) return [];

  const affordableTotal = maxSpendPerAttempt / gasLimit;
  const ceiling = affordableTotal > observed.baseFeePerGas
    ? affordableTotal - observed.baseFeePerGas
    : 0n;

  // Well above what the network is paying, measured against the p90 rather than the maximum.
  // Anchoring on the maximum was tried and is wrong in the other direction: a single 1,482 gwei
  // outlier in a 69-transaction sample dragged the whole window to 93 MON, and the window is the
  // part that runs on every rescue including the uncontested ones. 10x the p90 puts a full
  // window in the 10-20 MON range across observed mainnet traffic while still bidding hundreds
  // of times the median. Beating a genuine top bidder is what the escalation rungs are for —
  // they exist precisely for the case where the window did not settle it.
  // WINDOW_FEE_GWEI pins the window tip to an exact value, bypassing the live p90 sample. This is
  // for controlled fee experiments (e.g. a parity test where arm and the attacker must bid the SAME
  // tip): p90 x overtop is deterministic only if the sampled p90 holds still, which on a noisy chain
  // it does not (Q32 saw a p99 artifact swing it 20x). Not for production — there the live p90 is the
  // point. The ceiling (from MAX_SPEND_PER_ATTEMPT) still caps it.
  const fixedTipGwei = process.env.WINDOW_FEE_GWEI;
  const wanted = fixedTipGwei
    ? BigInt(fixedTipGwei) * 1_000_000_000n
    : observed.p90Priority > 0n
      ? observed.p90Priority * windowOvertop
      : observed.baseFeePerGas / 2n;
  const windowFee = wanted > ceiling ? ceiling : wanted;

  const flat = Math.max(1, Math.min(windowAttempts, attempts));
  const climbing = attempts - flat;

  const build = (maxPriorityFeePerGas: bigint, label: string): FeePlan => {
    const maxFeePerGas = observed.baseFeePerGas * 3n + maxPriorityFeePerGas;
    const costPerAttempt = gasLimit * (observed.baseFeePerGas + maxPriorityFeePerGas);
    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      costPerAttempt,
      overtopBy: observed.maxPrioritySeen > 0n
        ? Number((maxPriorityFeePerGas * 100n) / observed.maxPrioritySeen) / 100
        : Infinity,
      explanation:
        `${maxPriorityFeePerGas / 1_000_000_000n} gwei tip, ${formatEther(costPerAttempt)} MON${label}`,
    };
  };

  const plans: FeePlan[] = [];
  for (let i = 0; i < flat; i++) plans.push(build(windowFee, ' (window)'));

  for (let i = 0; i < climbing; i++) {
    // Cubic climb across the escalation rungs only. These fire after the window has closed, so
    // every one of them is evidence that something is beating us; the curve concentrates the
    // spend at the tail where that evidence is strongest.
    const progress = climbing === 1 ? 1 : i / (climbing - 1);
    const curved = progress * progress * progress;
    const scaled = windowFee + ((ceiling - windowFee) * BigInt(Math.round(curved * 10_000))) / 10_000n;
    plans.push(build(scaled < ceiling ? scaled : ceiling, ' (escalation)'));
  }
  return plans;
}
