import { parseAbiItem, getAddress } from 'viem';
import type { PublicClient } from 'viem';
import { STAKING_PRECOMPILE } from './staking.js';
import { maturityEpoch } from './epoch.js';

/**
 * Staking event discovery.
 *
 * The attacker's own `undelegate` transaction is the best source of truth we have. Its event
 * carries `validatorId` and `delegator` as indexed topics — so it filters server-side, per
 * address, cheaply — and its data carries `withdrawId`, `amount` and `activationEpoch`.
 *
 * That means nothing about the position needs to be configured by hand: the slot to claim, the
 * amount at stake and the exact maturity epoch all come out of the event that started the
 * theft. Asking an operator to type validator ids under time pressure is a way to get them
 * wrong.
 *
 * Lives in shared because both the watcher (detect and alert) and the rescue CLI (discover what
 * to claim) need identical decoding. Duplicating it would let the two drift.
 */

export const UNDELEGATE_EVENT = parseAbiItem(
  'event Undelegate(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 activationEpoch)',
);

export const WITHDRAW_EVENT = parseAbiItem(
  'event Withdraw(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 withdrawEpoch)',
);

/** Public endpoints cap eth_getLogs at 100 blocks, so every scan must page. */
export const MAX_LOG_RANGE = 100n;

export interface UnstakeEvent {
  validatorId: bigint;
  delegator: `0x${string}`;
  withdrawId: number;
  amount: bigint;
  /** Epoch the stake deactivates — NOT the maturity epoch. */
  activationEpoch: bigint;
  /** Epoch at which withdraw() succeeds: activationEpoch + WITHDRAWAL_DELAY. */
  maturesAtEpoch: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

/**
 * Scan a block range for unstakes by one delegator.
 *
 * Filtering is done server-side on the indexed `delegator` topic, so the node does the work and
 * we never pull the precompile's whole log volume across the wire.
 */
export async function scanUnstakes(
  client: PublicClient,
  delegator: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<UnstakeEvent[]> {
  const out: UnstakeEvent[] = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE) {
    const end = start + MAX_LOG_RANGE - 1n > toBlock ? toBlock : start + MAX_LOG_RANGE - 1n;
    const logs = await client.getLogs({
      address: STAKING_PRECOMPILE,
      event: UNDELEGATE_EVENT,
      args: { delegator },
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const a = log.args as {
        validatorId?: bigint; delegator?: `0x${string}`; withdrawId?: number;
        amount?: bigint; activationEpoch?: bigint;
      };
      if (a.validatorId === undefined || a.activationEpoch === undefined) continue;
      out.push({
        validatorId: a.validatorId,
        delegator: getAddress(a.delegator ?? delegator),
        withdrawId: Number(a.withdrawId ?? 0),
        amount: a.amount ?? 0n,
        activationEpoch: a.activationEpoch,
        maturesAtEpoch: maturityEpoch(a.activationEpoch),
        blockNumber: log.blockNumber ?? 0n,
        txHash: (log.transactionHash ?? '0x') as `0x${string}`,
      });
    }
  }
  return out;
}

/**
 * Discover a delegator's unstakes by walking backwards from the head until enough history is
 * covered.
 *
 * `lookbackBlocks` defaults to roughly three epochs, which is the longest a withdrawal can be
 * pending: anything older has either matured and been claimed, or is not ours to find. Scanning
 * further is wasted requests against a 100-block-per-call cap.
 */
export async function discoverUnstakes(
  client: PublicClient,
  delegator: `0x${string}`,
  lookbackBlocks = 160_000n,
): Promise<UnstakeEvent[]> {
  const head = await client.getBlockNumber();
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  return scanUnstakes(client, delegator, from, head);
}

/** Validator ids a delegator has unstaked from, deduped. */
export function validatorIdsFrom(events: readonly UnstakeEvent[]): bigint[] {
  return [...new Set(events.map((e) => e.validatorId))].sort((a, b) => (a < b ? -1 : 1));
}
