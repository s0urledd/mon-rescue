import { toEventSelector } from 'viem';
import type { PublicClient, Log } from 'viem';
import {
  boundaryBlockFor, earliestStartBlockFor, latestStartBlockFor,
  scanUnstakes, type UnstakeEvent,
} from '@monrescue/shared';

export { scanUnstakes, type UnstakeEvent };

/**
 * Attacker-unstake interception — the central loop.
 *
 * The scenario everything is built around: the attacker holds the seed and unstakes the
 * victim's position themselves. They cannot take it immediately, because `undelegate` puts the
 * funds behind `WITHDRAWAL_DELAY` for everyone including them. That delay is the entire
 * opportunity.
 *
 * The useful asymmetry is that **their own transaction tells us everything we need**. The
 * `Undelegate` event carries `validatorId` and `delegator` as indexed topics — so it can be
 * filtered cheaply per address — and its data carries `withdrawId`, `amount` and
 * `activationEpoch`. From one event we know exactly which slot to claim, how much is at stake,
 * and the exact epoch it matures (`activationEpoch + WITHDRAWAL_DELAY`).
 *
 * So the attacker starting the theft is also the attacker starting our clock, at a moment we
 * can see, with all the parameters handed to us. There is no guessing involved.
 *
 * We cannot undo their unbonding — there is no cancel primitive, and the funds sit inside the
 * precompile where nobody can touch them until maturity. What we can do is be armed and
 * pre-staged at the unlock block, where `withdraw()` pays `msg.sender` — the EOA — and a
 * destination-locked delegation takes it from there.
 */

export const WITHDRAW_TOPIC = toEventSelector(
  'event Withdraw(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 withdrawEpoch)',
);

export interface ArmingPlan {
  delegator: `0x${string}`;
  /** Every position to claim, grouped so one rescue() call can take them all. */
  validatorIds: bigint[];
  withdrawIds: number[];
  totalAmount: bigint;
  /** Earliest epoch at which any position becomes claimable. */
  firstMaturityEpoch: bigint;
  boundaryBlock: bigint;
  flipWindowStart: bigint;
  flipWindowEnd: bigint;
  events: UnstakeEvent[];
}

/**
 * Turn detected unstakes into something the hot path can act on.
 *
 * Positions maturing at the same epoch are batched into one rescue() call, since the contract
 * takes arrays and a single atomic transaction is strictly better than several racing ones.
 * Positions maturing at different epochs need separate arming runs — grouping them would mean
 * waiting for the latest, and conceding the earlier ones.
 */
export function buildArmingPlan(events: readonly UnstakeEvent[]): ArmingPlan[] {
  const byEpoch = new Map<bigint, UnstakeEvent[]>();
  for (const e of events) {
    const list = byEpoch.get(e.maturesAtEpoch) ?? [];
    list.push(e);
    byEpoch.set(e.maturesAtEpoch, list);
  }

  const plans: ArmingPlan[] = [];
  for (const [epoch, group] of [...byEpoch.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    plans.push({
      delegator: group[0]!.delegator,
      validatorIds: group.map((g) => g.validatorId),
      withdrawIds: group.map((g) => g.withdrawId),
      totalAmount: group.reduce((a, g) => a + g.amount, 0n),
      firstMaturityEpoch: epoch,
      boundaryBlock: boundaryBlockFor(epoch),
      flipWindowStart: earliestStartBlockFor(epoch),
      flipWindowEnd: latestStartBlockFor(epoch),
      events: group,
    });
  }
  return plans;
}

export interface InterceptOptions {
  client: PublicClient;
  /** Addresses to watch. */
  delegators: readonly `0x${string}`[];
  /** How often to scan, in ms. */
  intervalMs: number;
  onUnstake: (event: UnstakeEvent, plans: ArmingPlan[]) => void | Promise<void>;
  /** Also report the attacker completing a withdrawal — funds are now liquid on the EOA. */
  onWithdraw?: (log: Log) => void | Promise<void>;
}

/**
 * Watch for unstakes on the given addresses and emit arming plans.
 *
 * Deliberately reports EVERY unstake rather than trying to classify it as hostile. We cannot
 * tell the attacker's transaction from the owner's — both are signed by the same key. The
 * user decides; our job is to notice within seconds and hand them a plan and a deadline.
 */
export function watchForUnstakes(opts: InterceptOptions): () => void {
  let stopped = false;
  let cursor: bigint | undefined;
  const seen = new Set<string>();

  const loop = async () => {
    while (!stopped) {
      try {
        const head = await opts.client.getBlockNumber();
        // On first pass look back a little so a very recent unstake is not missed entirely.
        if (cursor === undefined) cursor = head > 200n ? head - 200n : 0n;

        if (head >= cursor) {
          for (const delegator of opts.delegators) {
            const events = await scanUnstakes(opts.client, delegator, cursor, head);
            const fresh = events.filter((e) => {
              const key = `${e.txHash}:${e.validatorId}:${e.withdrawId}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            if (fresh.length > 0) {
              const plans = buildArmingPlan(fresh);
              for (const e of fresh) await opts.onUnstake(e, plans);
            }
          }
          cursor = head + 1n;
        }
      } catch {
        // A failed scan must never end the watch; this has to survive for hours.
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
  };
  void loop();

  return () => { stopped = true; };
}

/** Human-readable summary for an alert. */
export function describeUnstake(e: UnstakeEvent, secondsPerBlock = 0.301): string {
  const epochHours = (50_000 * secondsPerBlock) / 3600;
  return (
    `Unstake detected on ${e.delegator}: ${e.amount / 10n ** 18n} MON from validator ` +
    `${e.validatorId} (slot ${e.withdrawId}).\n` +
    `Claimable at epoch ${e.maturesAtEpoch}, boundary block ${boundaryBlockFor(e.maturesAtEpoch)}, ` +
    `flip window ${earliestStartBlockFor(e.maturesAtEpoch)}..${latestStartBlockFor(e.maturesAtEpoch)}.\n` +
    `That is roughly ${epochHours.toFixed(1)}h per epoch of runway to get armed.\n` +
    `If you did NOT do this, your key is compromised — the funds are not gone yet, but they ` +
    `become claimable at that epoch and whoever calls withdraw first is paid.`
  );
}
