import {
  getDelegations, getDelegator, getValidator, getEpoch,
  getWithdrawalRequest, epochsUntilClaimable,
} from '@monrescue/shared';
import type { PublicClient } from 'viem';
import { formatCommission, formatMon } from './alerts.js';

/**
 * Read-only delegator portfolio lookup — the core of the public Telegram bot.
 *
 * Read-only and public by design: a user sends an address, gets back what that address has
 * staked. No authentication, no keys, nothing stored unless the user opts into watching.
 */

export interface Position {
  validatorId: bigint;
  validatorOk: boolean;
  commission: bigint;
  stake: bigint;
  unclaimedRewards: bigint;
  pendingWithdrawals: { withdrawId: number; amount: bigint; epochsRemaining: bigint }[];
}

export interface Portfolio {
  address: string;
  epoch: bigint;
  inEpochDelayPeriod: boolean;
  positions: Position[];
  totalStaked: bigint;
  totalRewards: bigint;
  totalUnbonding: bigint;
}

/** How many withdrawId slots to scan per validator. The protocol allows 0-255. */
const WITHDRAW_SLOTS_TO_SCAN = 16;

/**
 * Load a delegator's positions.
 *
 * `extraValidatorIds` exists because `getDelegations()` is NOT a complete source of truth for
 * outstanding withdrawals. Once a delegator's next-epoch stake reaches zero the precompile
 * removes them from the delegator linked list, even though their pending withdrawal requests
 * still exist and are still claimable. A user who unbonded their entire position — exactly the
 * case this project cares about — therefore disappears from `getDelegations` while still
 * having funds to rescue.
 *
 * So: use getDelegations for discovery, and always also scan any validator id we already know
 * about from elsewhere (a stored watch, a prior Undelegate event).
 */
export async function loadPortfolio(
  client: PublicClient,
  address: `0x${string}`,
  extraValidatorIds: readonly bigint[] = [],
): Promise<Portfolio> {
  const epoch = await getEpoch(client);
  const discovered = await getDelegations(client, address);
  const validatorIds = [...new Set([...discovered, ...extraValidatorIds])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const positions: Position[] = [];
  for (const validatorId of validatorIds) {
    const [d, v] = await Promise.all([
      getDelegator(client, validatorId, address),
      getValidator(client, validatorId),
    ]);

    // getWithdrawalRequest is the safe probe: an empty slot reads back as (0,0,0) rather than
    // reverting. withdraw() would revert with "unknown withdrawal id" and, because an invalid
    // staking call consumes all gas in its frame, that is an expensive way to discover a slot
    // is empty.
    const pending: Position['pendingWithdrawals'] = [];
    for (let slot = 0; slot < WITHDRAW_SLOTS_TO_SCAN; slot++) {
      const req = await getWithdrawalRequest(client, validatorId, address, slot);
      if (req.withdrawalAmount > 0n) {
        pending.push({
          withdrawId: slot,
          amount: req.withdrawalAmount,
          epochsRemaining: epochsUntilClaimable(epoch, req.withdrawEpoch),
        });
      }
    }

    positions.push({
      validatorId,
      validatorOk: v.flags === 0n,
      commission: v.commission,
      stake: d.stake,
      unclaimedRewards: d.unclaimedRewards,
      pendingWithdrawals: pending,
    });
  }

  return {
    address,
    epoch: epoch.epoch,
    inEpochDelayPeriod: epoch.inEpochDelayPeriod,
    positions,
    totalStaked: positions.reduce((a, p) => a + p.stake, 0n),
    totalRewards: positions.reduce((a, p) => a + p.unclaimedRewards, 0n),
    totalUnbonding: positions.reduce(
      (a, p) => a + p.pendingWithdrawals.reduce((b, w) => b + w.amount, 0n),
      0n,
    ),
  };
}

/** Render a portfolio for Telegram (HTML parse mode). */
export function renderPortfolio(p: Portfolio): string {
  if (p.positions.length === 0) {
    return `No delegations found for <code>${p.address}</code>.\n\nEpoch ${p.epoch}.`;
  }

  const lines: string[] = [];
  lines.push(`<b>Delegations for</b> <code>${p.address}</code>`);
  lines.push(`Epoch ${p.epoch}${p.inEpochDelayPeriod ? ' (in delay period)' : ''}`);
  lines.push('');

  for (const pos of p.positions) {
    const health = pos.validatorOk ? '' : '  ⚠️ <b>INACTIVE</b>';
    lines.push(`<b>Validator ${pos.validatorId}</b>${health}`);
    lines.push(`  Staked: ${formatMon(pos.stake)} MON`);
    lines.push(`  Rewards: ${formatMon(pos.unclaimedRewards)} MON`);
    lines.push(`  Commission: ${formatCommission(pos.commission)}`);
    for (const w of pos.pendingWithdrawals) {
      const when = w.epochsRemaining === 0n
        ? '<b>claimable now</b>'
        : `${w.epochsRemaining} epoch(s) remaining`;
      lines.push(`  Unbonding (slot ${w.withdrawId}): ${formatMon(w.amount)} MON — ${when}`);
    }
    lines.push('');
  }

  lines.push(`<b>Total staked:</b> ${formatMon(p.totalStaked)} MON`);
  lines.push(`<b>Total rewards:</b> ${formatMon(p.totalRewards)} MON`);
  if (p.totalUnbonding > 0n) {
    lines.push(`<b>Unbonding:</b> ${formatMon(p.totalUnbonding)} MON`);
  }
  return lines.join('\n');
}
