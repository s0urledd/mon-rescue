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

/** Decode raw Undelegate logs into UnstakeEvents. Shared by the fast path and the paged fallback. */
function decodeUnstakes(
  logs: ReadonlyArray<{
    args: {
      validatorId?: bigint; delegator?: `0x${string}`; withdrawId?: number;
      amount?: bigint; activationEpoch?: bigint;
    };
    blockNumber: bigint | null;
    transactionHash: `0x${string}` | null;
  }>,
  delegator: `0x${string}`,
): UnstakeEvent[] {
  const out: UnstakeEvent[] = [];
  for (const log of logs) {
    const a = log.args;
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
  return out;
}

/**
 * Scan a block range for unstakes by one delegator.
 *
 * Filtering is done server-side on the indexed `delegator` topic, so the node does the work and
 * we never pull the precompile's whole log volume across the wire.
 *
 * Two paths:
 *  - FAST: one getLogs over the whole range. A local node — and most RPCs — serve this in a single
 *    round-trip. The `MAX_LOG_RANGE` cap below is a *public-endpoint* limit; forcing every scan
 *    through it turns one query into thousands and, over a multi-day lookback on a local WS node,
 *    hung an intake for 5+ minutes (`discovering positions...` with nothing after it). Time-to-armed
 *    is the whole metric in an emergency, so we try the wide call first.
 *  - PAGED fallback: only if the endpoint refuses the range (throws). Bounded-concurrency 100-block
 *    windows, each window's failure swallowed so one bad range never abandons the scan.
 *
 * Set `FORCE_LOG_PAGING=1` to skip the fast path — for an endpoint that silently truncates an
 * oversized range instead of erroring (paging is then the only way to be sure nothing is missed).
 */
export async function scanUnstakes(
  client: PublicClient,
  delegator: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<UnstakeEvent[]> {
  const sort = (evs: UnstakeEvent[]) => evs.sort((x, y) => (x.blockNumber < y.blockNumber ? -1 : 1));

  if (process.env.FORCE_LOG_PAGING !== '1') {
    try {
      const logs = await client.getLogs({
        address: STAKING_PRECOMPILE,
        event: UNDELEGATE_EVENT,
        args: { delegator },
        fromBlock,
        toBlock,
      });
      return sort(decodeUnstakes(logs, delegator));
    } catch {
      // Endpoint capped the range — fall through to bounded-concurrency paging.
    }
  }

  const windows: Array<[bigint, bigint]> = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE) {
    const end = start + MAX_LOG_RANGE - 1n > toBlock ? toBlock : start + MAX_LOG_RANGE - 1n;
    windows.push([start, end]);
  }

  const concurrency = Number(process.env.LOG_SCAN_CONCURRENCY ?? 24);
  const out: UnstakeEvent[] = [];

  for (let i = 0; i < windows.length; i += concurrency) {
    const results = await Promise.all(
      windows.slice(i, i + concurrency).map(([from, to]) =>
        client
          .getLogs({
            address: STAKING_PRECOMPILE,
            event: UNDELEGATE_EVENT,
            args: { delegator },
            fromBlock: from,
            toBlock: to,
          })
          // One unlucky window must not abandon the whole scan; a missed range is better than
          // no result, and the caller can widen the lookback if something looks absent.
          .catch(() => []),
      ),
    );

    for (const logs of results) out.push(...decodeUnstakes(logs, delegator));
  }

  return sort(out);
}

/**
 * Discover a delegator's unstakes by walking backwards from the head until enough history is
 * covered.
 *
 * `lookbackBlocks` defaults to ~700,000 blocks — about 14 epochs, or two and a half days at the
 * measured cadence. The earlier 160,000 (~13 hours) assumed a withdrawal is claimed promptly
 * after maturing, and it silently missed a position that had been pending for two days. That is
 * exactly the case an emergency intake must handle: nobody arrives on time.
 */
export async function discoverUnstakes(
  client: PublicClient,
  delegator: `0x${string}`,
  lookbackBlocks = BigInt(process.env.UNSTAKE_LOOKBACK_BLOCKS ?? 700_000),
): Promise<UnstakeEvent[]> {
  const head = await client.getBlockNumber();
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  return scanUnstakes(client, delegator, from, head);
}

/** Validator ids a delegator has unstaked from, deduped. */
export function validatorIdsFrom(events: readonly UnstakeEvent[]): bigint[] {
  return [...new Set(events.map((e) => e.validatorId))].sort((a, b) => (a < b ? -1 : 1));
}
