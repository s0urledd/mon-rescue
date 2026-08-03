/**
 * Create the unbonding position that Script B needs.
 *
 * Usage:
 *   ACTION=delegate    AMOUNT=100  -> stake MON with a validator
 *   ACTION=undelegate  AMOUNT=100  -> start unbonding; prints the unlock epoch
 *   ACTION=status                  -> show position, pending withdrawals, epoch countdown
 *
 * The unbonding wait is one full epoch (~5.5h), so run `undelegate` and then come back.
 * `status` tells you when to run Script B.
 */
import { createWalletClient, http, formatEther, parseEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, STAKING_PRECOMPILE, STAKING_ABI,
  getEpoch, getDelegator, getWithdrawalRequest, getDelegations,
  withdrawableAtEpoch, epochsUntilClaimable, STAKING_CONSTANTS,
} from '@monrescue/shared';
import { requireEnv } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const ACTION = (process.env.ACTION ?? 'status').toLowerCase();

async function main() {
  const pk = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const publicClient = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  const epoch = await getEpoch(publicClient);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`account: ${account.address}`);
  console.log(`balance: ${formatEther(balance)} MON`);
  console.log(`epoch:   ${epoch.epoch}${epoch.inEpochDelayPeriod ? ' (past boundary block — in delay period)' : ''}\n`);

  if (ACTION === 'status') {
    const validatorIds = await getDelegations(publicClient, account.address);
    if (validatorIds.length === 0) {
      console.log('no delegations. Run ACTION=delegate AMOUNT=100 VALIDATOR_ID=1 first.');
      return;
    }
    for (const id of validatorIds) {
      const d = await getDelegator(publicClient, id, account.address);
      console.log(`validator ${id}: stake=${formatEther(d.stake)} MON rewards=${formatEther(d.unclaimedRewards)} MON`);
      for (let slot = 0; slot < 8; slot++) {
        const req = await getWithdrawalRequest(publicClient, id, account.address, slot);
        if (req.withdrawalAmount === 0n) continue;
        const remaining = epochsUntilClaimable(epoch, req.withdrawEpoch);
        console.log(
          `  withdrawal slot ${slot}: ${formatEther(req.withdrawalAmount)} MON, unlock epoch ${req.withdrawEpoch}, ` +
            (remaining === 0n
              ? 'CLAIMABLE NOW — run script:b'
              : `${remaining} epoch(s) to go (~${Number(remaining) * 5.5}h)`),
        );
      }
    }
    return;
  }

  const validatorId = BigInt(requireEnv('VALIDATOR_ID'));
  const amount = parseEther(requireEnv('AMOUNT'));

  if (ACTION === 'delegate') {
    if (amount < STAKING_CONSTANTS.DUST_THRESHOLD) {
      throw new Error(`amount below DUST_THRESHOLD (${STAKING_CONSTANTS.DUST_THRESHOLD} wei)`);
    }
    console.log(`delegating ${formatEther(amount)} MON to validator ${validatorId}...`);
    const data = encodeFunctionData({ abi: STAKING_ABI, functionName: 'delegate', args: [validatorId] });
    const hash = await wallet.sendTransaction({ to: STAKING_PRECOMPILE, data, value: amount });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`${hash} -> ${r.status}`);
    console.log(`\nDelegations activate at an epoch boundary. Run ACTION=status to watch.`);
    return;
  }

  if (ACTION === 'undelegate') {
    const withdrawId = Number(process.env.WITHDRAW_ID ?? 0);

    // undelegate reverts if a pending withdrawal already occupies this slot. withdrawId is a
    // uint8, so there are only 256 slots per (validator, delegator) — an attacker can grief
    // by filling them, which is why we check rather than assume.
    const existing = await getWithdrawalRequest(publicClient, validatorId, account.address, withdrawId);
    if (existing.withdrawalAmount > 0n) {
      throw new Error(
        `withdrawId ${withdrawId} already holds a pending withdrawal of ${formatEther(existing.withdrawalAmount)} MON. ` +
          `Pick a free slot with WITHDRAW_ID=<n>.`,
      );
    }

    console.log(`undelegating ${formatEther(amount)} MON from validator ${validatorId} into slot ${withdrawId}...`);
    const data = encodeFunctionData({
      abi: STAKING_ABI, functionName: 'undelegate', args: [validatorId, amount, withdrawId],
    });
    const hash = await wallet.sendTransaction({ to: STAKING_PRECOMPILE, data });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`${hash} -> ${r.status}`);

    const after = await getEpoch(publicClient);
    const predicted = withdrawableAtEpoch(after);
    const actual = await getWithdrawalRequest(publicClient, validatorId, account.address, withdrawId);
    console.log(`\npredicted unlock epoch: ${predicted}`);
    console.log(`on-chain withdrawEpoch:  ${actual.withdrawEpoch}`);
    if (predicted !== actual.withdrawEpoch) {
      console.log(
        `NOTE: prediction and on-chain value differ. The reference is ambiguous about which ` +
          `epoch withdrawEpoch records — record this in FINDINGS.md, the on-chain value wins.`,
      );
    }
    console.log(`\nRun ACTION=status periodically; when it says CLAIMABLE NOW, run script:b.`);
    return;
  }

  throw new Error(`unknown ACTION "${ACTION}" (expected delegate | undelegate | status)`);
}

main().catch((e) => { console.error(`\nsetup-stake failed: ${e.message}`); process.exit(1); });
