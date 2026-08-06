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
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, parseEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, STAKING_PRECOMPILE, STAKING_ABI,
  getEpoch, getDelegator, getWithdrawalRequest, getDelegations,
  withdrawableAtEpoch, epochsUntilClaimable, maturityEpoch, STAKING_CONSTANTS,
  STAKING_GAS, reserveFloor,
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

    // Check locally that this account can actually part with `amount`. Two separate limits bind,
    // and neither announces itself: the transaction is included and reverts, consuming the whole
    // gas limit to tell us a number we already had.
    //
    //  1. Plain funds: value + gas must fit in the balance.
    //  2. The reserve floor, but ONLY if this account is 7702-delegated. A delegated account
    //     ends the transaction at `min(start, 10 MON)` minus gas spend, so the most it can send
    //     as value is `balance - reserveFloor(balance)` — which is ZERO for any delegated
    //     account holding under 10 MON. Our own script:a delegation imposes that floor, so the
    //     victim account is exactly the one that hits it.
    const code = await publicClient.getCode({ address: account.address });
    const delegated = !!code && code.toLowerCase().startsWith('0xef0100');
    const fees = await publicClient.estimateFeesPerGas();
    const gasCost = STAKING_GAS.delegate * (fees.maxFeePerGas ?? 200_000_000_000n);
    const floor = delegated ? reserveFloor(balance) : 0n;
    const spendable = balance > floor ? balance - floor : 0n;

    if (amount + gasCost > balance || amount > spendable) {
      throw new Error(
        `cannot delegate ${formatEther(amount)} MON from ${account.address}.\n` +
          `  balance:        ${formatEther(balance)} MON\n` +
          `  gas allowance:  ${formatEther(gasCost)} MON (${STAKING_GAS.delegate} gas)\n` +
          (delegated
            ? `  reserve floor:  ${formatEther(floor)} MON — this account is 7702-delegated to ` +
              `${code!.slice(8)}, so it may not end below min(balance, 10 MON)\n` +
              `  max delegatable: ${formatEther(spendable > gasCost ? spendable - gasCost : 0n)} MON\n` +
              (spendable === 0n
                ? `  A delegated account holding under 10 MON cannot send ANY value. Fund it to ` +
                  `10 MON + ${formatEther(amount)} + gas, or revoke the 7702 delegation first ` +
                  `(a delegation to the zero address, as script:c does in its third phase).`
                : `  Reduce AMOUNT, or fund the account.`)
            : `  max delegatable: ${formatEther(balance > gasCost ? balance - gasCost : 0n)} MON\n` +
              `  Reduce AMOUNT, or fund the account.`),
      );
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

    // Check available stake locally. The precompile reverts with "insufficient stake" and
    // consumes the whole gas limit doing so, which is an expensive and uninformative way to
    // discover the number — especially since only ACTIVATED stake counts, so a delegation made
    // this epoch reads as unavailable.
    const del = await getDelegator(publicClient, validatorId, account.address);
    if (del.stake < amount) {
      const pending: string[] = [];
      for (let s = 0; s < 8; s++) {
        const r = await getWithdrawalRequest(publicClient, validatorId, account.address, s);
        if (r.withdrawalAmount > 0n) {
          pending.push(`slot ${s}: ${formatEther(r.withdrawalAmount)} MON (claimable at epoch ${maturityEpoch(r.withdrawEpoch)})`);
        }
      }
      throw new Error(
        `insufficient active stake on validator ${validatorId}: have ${formatEther(del.stake)} MON, ` +
          `asked for ${formatEther(amount)} MON.\n` +
          (pending.length
            ? `  Already pending:\n    ${pending.join('\n    ')}\n` +
              `  Undelegated stake is no longer available — withdraw it first, or delegate more.`
            : `  Note only ACTIVATED stake can be undelegated; a delegation made this epoch is not yet active.`),
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
    const actual = await getWithdrawalRequest(publicClient, validatorId, account.address, withdrawId);

    // Compare like with like. withdrawEpoch is the ACTIVATION epoch (n+1, or n+2 past the
    // boundary block); maturity is one WITHDRAWAL_DELAY beyond it. An earlier version compared
    // a maturity prediction against the activation field and reported every correct run as a
    // mismatch.
    const predictedActivation = after.epoch + (after.inEpochDelayPeriod ? 2n : 1n);
    const predictedMaturity = withdrawableAtEpoch(after);

    console.log(`\nactivation epoch:  predicted ${predictedActivation}, on-chain ${actual.withdrawEpoch}` +
      `${predictedActivation === actual.withdrawEpoch ? '  (match)' : '  !! MISMATCH'}`);
    console.log(`claimable at epoch: ${maturityEpoch(actual.withdrawEpoch)}` +
      `${maturityEpoch(actual.withdrawEpoch) === predictedMaturity ? '  (match)' : '  !! MISMATCH'}`);

    if (predictedActivation !== actual.withdrawEpoch) {
      console.log(
        `\nNOTE: activation differs from the prediction. The on-chain value is authoritative — ` +
          `record it in FINDINGS.md and check maturityEpoch().`,
      );
    }

    // The dust sweep can silently enlarge the request past what was requested.
    if (actual.withdrawalAmount !== amount) {
      console.log(
        `\nNOTE: recorded ${formatEther(actual.withdrawalAmount)} MON, requested ${formatEther(amount)} — ` +
          `the precompile folds a sub-1-gwei remainder into the withdrawal.`,
      );
    }
    console.log(`\nRun ACTION=status periodically; when it says CLAIMABLE NOW, run script:b.`);
    return;
  }

  throw new Error(`unknown ACTION "${ACTION}" (expected delegate | undelegate | status)`);
}

main().catch((e) => { console.error(`\nsetup-stake failed: ${e.message}`); process.exit(1); });
