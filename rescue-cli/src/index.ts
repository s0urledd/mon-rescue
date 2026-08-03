import { createWalletClient, http, encodeFunctionData, formatEther, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, getEpoch, getWithdrawalRequest,
  planSweep, assertSweepAllowed, isClaimable,
} from '@monrescue/shared';
import { broadcastEverywhere } from './broadcast.js';
import { MONRESCUE_ABI } from './abi.js';

/**
 * Guardian hot path.
 *
 * Design constraints that came out of Phase 0 and are load-bearing here:
 *
 *  - There is NO computable unlock block. Rounds advance independently of blocks, so an epoch
 *    boundary cannot be predicted arithmetically. The trigger is therefore a polled
 *    `getEpoch()` transition, not a scheduled block height (FINDINGS.md Q6).
 *  - Rescued funds always land on the compromised EOA, because no staking function takes a
 *    recipient (Q5). The claim and the sweep must be one transaction.
 *  - The sweep must respect a floor of min(startBalance, 10 MON) or the whole transaction
 *    reverts and the window is wasted (Q3). We check before broadcasting, never after.
 *
 * The guardian key is supplied at runtime and only ever pays gas. It cannot choose a
 * destination — that is fixed in the rescue contract's immutable storage.
 */

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 143);
/** Epoch polling cadence. This is the reaction time of the whole system. */
const POLL_MS = Number(process.env.EPOCH_POLL_MS ?? 500);

interface Target {
  victim: `0x${string}`;
  validatorId: bigint;
  withdrawId: number;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required environment variable ${key} (secrets are runtime-only, never committed)`);
  return v;
}

async function main() {
  const guardianKey = requireEnv('GUARDIAN_PRIVATE_KEY') as `0x${string}`;
  const target: Target = {
    victim: requireEnv('VICTIM_ADDRESS') as `0x${string}`,
    validatorId: BigInt(requireEnv('VALIDATOR_ID')),
    withdrawId: Number(process.env.WITHDRAW_ID ?? 0),
  };

  const guardian = privateKeyToAccount(guardianKey);
  const chain = chainById(CHAIN_ID);
  const urls = RPC_POOL[CHAIN_ID] ?? [];
  const client = publicClientFor(CHAIN_ID, urls[0]);
  const wallet = createWalletClient({ account: guardian, chain, transport: http(urls[0]) });

  console.log(`guardian:   ${guardian.address}`);
  console.log(`victim EOA: ${target.victim}`);
  console.log(`broadcast pool: ${urls.length} endpoint(s)`);

  // Refuse to arm against an account that is not delegated to a rescue contract — otherwise
  // the transaction is guaranteed to do nothing when it finally fires.
  const code = await client.getCode({ address: target.victim });
  if (!code || code === '0x') {
    throw new Error(`${target.victim} is not EIP-7702 delegated — nothing to trigger. The user must complete the approval step first.`);
  }
  console.log(`victim delegation: ${code}`);

  const req = await getWithdrawalRequest(client, target.validatorId, target.victim, target.withdrawId);
  if (req.withdrawalAmount === 0n) {
    throw new Error(`no pending withdrawal at validator ${target.validatorId} slot ${target.withdrawId}`);
  }
  console.log(`pending withdrawal: ${formatEther(req.withdrawalAmount)} MON, unlocks at epoch ${req.withdrawEpoch}`);

  // Reserve check happens now, while there is time to react, not in the millisecond we fire.
  const startBalance = await client.getBalance({ address: target.victim });
  const plan = planSweep(startBalance, req.withdrawalAmount);
  console.log(`reserve floor ${formatEther(plan.floor)} MON, sweepable ${formatEther(plan.sweepable)} MON`);
  if (plan.stranded > 0n) {
    console.warn(
      `WARNING: ${formatEther(plan.stranded)} MON will remain stranded on the EOA. Releasing it ` +
        `requires undelegating first, then 3 quiet blocks. This is a separate operation.`,
    );
  }
  assertSweepAllowed(startBalance, req.withdrawalAmount, plan.sweepable);

  // --- pre-sign, then hold in memory --------------------------------------
  const data = encodeFunctionData({
    abi: MONRESCUE_ABI,
    functionName: 'rescue',
    args: [[target.validatorId], [target.withdrawId], true],
  });

  const fees = await client.estimateFeesPerGas();
  // The rescued value dwarfs any plausible fee, so we bid to win the ordering race rather
  // than to be economical. This is the fee lever from FINDINGS.md; latency is the other.
  const priorityMultiplier = BigInt(process.env.PRIORITY_FEE_MULTIPLIER ?? 5);
  const nonce = await client.getTransactionCount({ address: guardian.address });

  const rawTx = await wallet.signTransaction({
    to: target.victim,
    data,
    nonce,
    gas: BigInt(process.env.GAS_LIMIT ?? 1_000_000),
    maxFeePerGas: (fees.maxFeePerGas ?? parseGwei('50')) * priorityMultiplier,
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas ?? parseGwei('2')) * priorityMultiplier,
    chain,
  });
  console.log(`\nrescue transaction pre-signed and held in memory (nonce ${nonce}).`);
  console.log(`waiting for epoch ${req.withdrawEpoch}; polling every ${POLL_MS}ms`);

  // --- arm: poll getEpoch() and fire on the transition ---------------------
  for (;;) {
    let epoch;
    try {
      epoch = await getEpoch(client);
    } catch (e) {
      // A single failed poll must never end the watch — this process may need to survive days.
      if (process.env.DEBUG) console.error(`poll error: ${(e as Error).message}`);
      await sleep(POLL_MS);
      continue;
    }

    if (isClaimable(epoch, req.withdrawEpoch)) {
      console.log(`\nepoch ${epoch.epoch} reached — FIRING`);
      const t0 = Date.now();
      const result = await broadcastEverywhere(CHAIN_ID, rawTx, urls);
      console.log(`broadcast completed in ${Date.now() - t0}ms`);
      for (const a of result.attempts) {
        console.log(`  ${a.url} ${a.ms}ms ${a.hash ? `-> ${a.hash}` : `ERR ${a.error}`}`);
      }
      if (!result.hash) throw new Error('every endpoint rejected the rescue transaction');

      const receipt = await client.waitForTransactionReceipt({ hash: result.hash });
      console.log(`\nreceipt: ${receipt.status} in block ${receipt.blockNumber}`);
      process.exit(receipt.status === 'success' ? 0 : 1);
    }

    await sleep(POLL_MS);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(`\nrescue-cli failed: ${e.message}`);
  process.exit(1);
});
