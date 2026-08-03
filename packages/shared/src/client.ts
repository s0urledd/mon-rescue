import { createPublicClient, http, decodeFunctionResult, encodeFunctionData } from 'viem';
import type { PublicClient } from 'viem';
import { chainById, RPC_POOL } from './chains.js';
import { STAKING_ABI, STAKING_PRECOMPILE } from './staking.js';
import type { EpochState } from './epoch.js';

export function publicClientFor(chainId: number, rpcUrl?: string): PublicClient {
  const url = rpcUrl ?? RPC_POOL[chainId]?.[0];
  if (!url) throw new Error(`no RPC configured for chain ${chainId}`);
  return createPublicClient({ chain: chainById(chainId), transport: http(url) });
}

/**
 * Read the staking precompile.
 *
 * Every "view" on the precompile is declared nonpayable because STATICCALL
 * reverts there, so viem's readContract (which emits a view-style call) is not
 * usable. We issue a raw eth_call and decode the result ourselves.
 */
async function callStaking<TName extends string>(
  client: PublicClient,
  functionName: TName,
  args: readonly unknown[],
) {
  const data = encodeFunctionData({
    abi: STAKING_ABI,
    functionName: functionName as never,
    args: args as never,
  });
  const { data: result } = await client.call({ to: STAKING_PRECOMPILE, data });
  if (!result) throw new Error(`staking call ${functionName} returned no data`);
  return decodeFunctionResult({
    abi: STAKING_ABI,
    functionName: functionName as never,
    data: result,
  });
}

export async function getEpoch(client: PublicClient): Promise<EpochState> {
  const [epoch, inEpochDelayPeriod] = (await callStaking(client, 'getEpoch', [])) as readonly [
    bigint,
    boolean,
  ];
  return { epoch, inEpochDelayPeriod };
}

export interface DelegatorPosition {
  validatorId: bigint;
  stake: bigint;
  unclaimedRewards: bigint;
  deltaStake: bigint;
  nextDeltaStake: bigint;
  deltaEpoch: bigint;
  nextDeltaEpoch: bigint;
}

export async function getDelegator(
  client: PublicClient,
  validatorId: bigint,
  delegator: `0x${string}`,
): Promise<DelegatorPosition> {
  const r = (await callStaking(client, 'getDelegator', [validatorId, delegator])) as readonly [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint,
  ];
  return {
    validatorId,
    stake: r[0],
    unclaimedRewards: r[2],
    deltaStake: r[3],
    nextDeltaStake: r[4],
    deltaEpoch: r[5],
    nextDeltaEpoch: r[6],
  };
}

/** Walk the paginated getDelegations() view to list every validator an address delegates to. */
export async function getDelegations(
  client: PublicClient,
  delegator: `0x${string}`,
): Promise<bigint[]> {
  const all: bigint[] = [];
  let startValId = 0n;
  // Bounded so a misbehaving endpoint cannot spin forever.
  for (let page = 0; page < 64; page++) {
    const [isDone, nextValId, valIds] = (await callStaking(client, 'getDelegations', [
      delegator,
      startValId,
    ])) as readonly [boolean, bigint, readonly bigint[]];
    all.push(...valIds);
    if (isDone) return all;
    startValId = nextValId;
  }
  return all;
}

export interface ValidatorInfo {
  validatorId: bigint;
  authAddress: `0x${string}`;
  flags: bigint;
  stake: bigint;
  commission: bigint;
  unclaimedRewards: bigint;
  consensusStake: bigint;
}

export async function getValidator(
  client: PublicClient,
  validatorId: bigint,
): Promise<ValidatorInfo> {
  const r = (await callStaking(client, 'getValidator', [validatorId])) as readonly unknown[];
  return {
    validatorId,
    authAddress: r[0] as `0x${string}`,
    flags: r[1] as bigint,
    stake: r[2] as bigint,
    commission: r[4] as bigint,
    unclaimedRewards: r[5] as bigint,
    consensusStake: r[6] as bigint,
  };
}

export interface WithdrawalRequest {
  withdrawalAmount: bigint;
  withdrawEpoch: bigint;
}

export async function getWithdrawalRequest(
  client: PublicClient,
  validatorId: bigint,
  delegator: `0x${string}`,
  withdrawId: number,
): Promise<WithdrawalRequest> {
  const r = (await callStaking(client, 'getWithdrawalRequest', [
    validatorId,
    delegator,
    withdrawId,
  ])) as readonly [bigint, bigint, bigint];
  return { withdrawalAmount: r[0], withdrawEpoch: r[2] };
}
