import type { PublicClient } from 'viem';
import { formatEther } from 'viem';

/**
 * Gas sponsorship preflight.
 *
 * The scenario worth being explicit about: what happens when the compromised account has no
 * MON at all, or the attacker sweeps its balance seconds before the unlock?
 *
 * **Nothing. The victim's balance is irrelevant to whether the rescue can execute.**
 *
 * The rescue transaction is sent BY the guardian and paid for BY the guardian; the victim's
 * address is only the `to` target. EIP-7702 is explicit that an authorization "can be
 * submitted by the EOA themselves, or by anyone else … This will allow EOAs to behave like
 * smart contracts without any funds for gas!" So a completely empty compromised account is
 * rescuable, and an attacker draining it changes nothing about our path.
 *
 * This is the single biggest structural advantage over the classic Ethereum rescue pattern.
 * Tools like flashbots/searcher-sponsored-tx and codeesura's rescuers must first send ETH to
 * the compromised wallet so it can pay its own gas — which a sweeper bot steals on arrival.
 * That race is the entire reason those tools need Flashbots bundles. We never fund the victim,
 * so the race does not exist. `pcaversaccio/white-hat-frontrunning` reaches the same conclusion
 * for the same reason.
 *
 * The requirement simply moves: **the GUARDIAN must stay funded**, and that is under our
 * control rather than the attacker's. This module enforces it.
 */

/**
 * Monad caps an account's total gas across its inflight transactions (last 3 blocks) at
 * min(10 MON, lagged balance). A guardian sitting near or below this has its retries throttled
 * at precisely the moment it needs to retry, so we treat it as a hard floor rather than advice.
 */
export const GUARDIAN_INFLIGHT_FLOOR = 10_000_000_000_000_000_000n; // 10 MON

/**
 * Monad's minimum base fee: 100 MON-gwei. Note `eth_maxPriorityFeePerGas` returns a HARDCODED
 * 2 gwei on Monad rather than a live recommendation, so fee estimation from RPC is not a real
 * oracle and must not be trusted as one.
 */
export const MIN_BASE_FEE_PER_GAS = 100_000_000_000n; // 100 gwei

/**
 * Gas is charged on the gas LIMIT, not gas used, and there are no gas refunds. A generous
 * limit is money burned on every attempt and, worse, it consumes the inflight budget that
 * bounds how many attempts we can have in flight at once. Keep this tight and measured.
 */
export const DEFAULT_RESCUE_GAS_LIMIT = 350_000n;

/**
 * Operator policy: what we are willing to burn to win.
 *
 * The rescued position is worth far more than any plausible fee, so the objective function is
 * probability of success, not cost. A rescue that spends 500 MON on gas and works beats one
 * that spends 5 and loses. This budget exists so that "spend aggressively" is a bounded,
 * deliberate decision rather than an unbounded loop.
 *
 * Override with RESCUE_GAS_BUDGET_MON.
 */
export const DEFAULT_GAS_BUDGET = 500_000_000_000_000_000_000n; // 500 MON

export function gasBudgetFromEnv(): bigint {
  const raw = process.env.RESCUE_GAS_BUDGET_MON;
  if (!raw) return DEFAULT_GAS_BUDGET;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`RESCUE_GAS_BUDGET_MON must be a positive number of MON, got "${raw}"`);
  }
  return BigInt(Math.round(parsed * 1e6)) * 10n ** 12n;
}

/**
 * How many attempts a budget affords at a given gas limit and price. Used to size the spray
 * from the budget rather than from a guess.
 */
export function attemptsAffordable(budget: bigint, gasLimit: bigint, gasPrice: bigint): number {
  const perAttempt = gasLimit * gasPrice;
  if (perAttempt === 0n) return 0;
  return Number(budget / perAttempt);
}

/**
 * How many attempts can be inflight simultaneously, given the reserve-balance rule
 * `sum(gas_price * gas_limit) <= min(10 MON, lagged balance)`.
 *
 * Note "lagged": the budget is measured against the balance at block n-k, so topping the
 * guardian up does not raise this ceiling for ~3 blocks.
 */
export function maxInflightAttempts(
  gasLimit: bigint,
  gasPrice: bigint,
  guardianBalance: bigint,
): number {
  const budget = guardianBalance < GUARDIAN_INFLIGHT_FLOOR ? guardianBalance : GUARDIAN_INFLIGHT_FLOOR;
  const perTx = gasLimit * gasPrice;
  if (perTx === 0n) return 0;
  return Number(budget / perTx);
}

export interface PreflightResult {
  ok: boolean;
  guardianBalance: bigint;
  victimBalance: bigint;
  estimatedCost: bigint;
  warnings: string[];
  errors: string[];
}

export interface PreflightParams {
  client: PublicClient;
  guardian: `0x${string}`;
  victim: `0x${string}`;
  /** Gas limit per rescue attempt. */
  gas: bigint;
  maxFeePerGas: bigint;
  /** How many attempts the spray may send. */
  plannedAttempts: number;
}

export async function preflight(p: PreflightParams): Promise<PreflightResult> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const [guardianBalance, victimBalance] = await Promise.all([
    p.client.getBalance({ address: p.guardian }),
    p.client.getBalance({ address: p.victim }),
  ]);

  // Worst case: every spray attempt lands and is charged. On Monad the charge is the gas
  // LIMIT, not gas used, and there are no refunds — so a premature attempt that reverts after
  // 40k gas still costs the full limit. That makes the limit, not the expected usage, the
  // number that matters for budgeting.
  const estimatedCost = p.gas * p.maxFeePerGas * BigInt(Math.max(1, p.plannedAttempts));

  if (p.gas > 600_000n) {
    warnings.push(
      `gas limit ${p.gas} is high. Monad charges the gas LIMIT rather than gas used and gives ` +
        `no refunds, so every attempt pays this in full and it also consumes the inflight ` +
        `budget that caps how many attempts can be in flight at once.`,
    );
  }

  if (guardianBalance < estimatedCost) {
    errors.push(
      `guardian holds ${formatEther(guardianBalance)} MON but the planned ${p.plannedAttempts} ` +
        `attempt(s) could cost up to ${formatEther(estimatedCost)} MON. Fund the guardian before arming.`,
    );
  }

  if (guardianBalance < GUARDIAN_INFLIGHT_FLOOR) {
    warnings.push(
      `guardian holds ${formatEther(guardianBalance)} MON, below the ${formatEther(GUARDIAN_INFLIGHT_FLOOR)} MON ` +
        `inflight-gas ceiling. Monad caps per-account inflight gas at min(10 MON, lagged balance) ` +
        `over 3 blocks, so retries will be throttled exactly when they matter most.`,
    );
  }

  // Stated positively so nobody "fixes" an empty victim by sending it MON — which would
  // create the very race this design avoids, and hand the attacker free money.
  if (victimBalance === 0n) {
    warnings.push(
      `victim holds 0 MON. This is FINE and needs no action: the guardian pays all gas and the ` +
        `victim never needs a balance. Do NOT send MON to the compromised account — it would be ` +
        `stolen and would create a race this design otherwise avoids.`,
    );
  }

  return {
    ok: errors.length === 0,
    guardianBalance,
    victimBalance,
    estimatedCost,
    warnings,
    errors,
  };
}

/**
 * Watch the guardian's balance while armed. A guardian that runs dry mid-window fails silently
 * otherwise — broadcasts are simply rejected — and silence is indistinguishable from "nothing
 * has happened yet".
 */
export function watchGuardianBalance(
  client: PublicClient,
  guardian: `0x${string}`,
  minimum: bigint,
  intervalMs: number,
  onLow: (balance: bigint) => void,
): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const b = await client.getBalance({ address: guardian });
        if (b < minimum) onLow(b);
      } catch {
        /* a failed read is not evidence of a low balance */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void loop();
  return () => { stopped = true; };
}
