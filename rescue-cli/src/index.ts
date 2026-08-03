import { createWalletClient, http, encodeFunctionData, formatEther, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, getEpoch, getWithdrawalRequest, planSweep, assertSweepAllowed,
  isClaimable, advise, boundaryBlockFor, earliestStartBlockFor, latestStartBlockFor,
  localFirstClient, transportConfigFromEnv,
} from '@monrescue/shared';
import { MONRESCUE_ABI } from './abi.js';
import { spray, attemptsNeeded, makeSafeBalanceChecker, type SprayAttempt } from './strategies.js';
import { watchAccount, delegationTarget } from './guard.js';

/**
 * Guardian hot path.
 *
 * The design follows STRATEGY.md: the primary mechanism is a pre-submitted spray that keeps a
 * signed rescue queued across the unlock uncertainty window, so a transaction is already at
 * the leader when the epoch flips and there is no reaction time to pay. Polling is the
 * backstop, not the plan.
 *
 * Constraints from Phase 0 that shape this file:
 *  - No staking function accepts a recipient, so rescued funds land on the compromised EOA and
 *    the claim and sweep must share one transaction (Q5).
 *  - The boundary block is exactly (epoch-1) * 50,000 and the epoch begins within 5,000 blocks
 *    of it, so the unlock is known to ~40 blocks and we can sleep until it matters (Q6).
 *  - The sweep must respect a floor of min(startBalance, 10 MON) or the whole transaction
 *    reverts (Q3, still UNVERIFIED — see FINDINGS.md).
 *
 * The guardian key only pays gas. It cannot choose a destination; that is immutable in the
 * contract. No user private key or seed is ever accepted.
 */

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 143);
const MIN_POLL_MS = Number(process.env.EPOCH_POLL_MS ?? 500);
const SPRAY_ENABLED = (process.env.SPRAY_ENABLED ?? 'true') !== 'false';
const SPRAY_BLOCKS_PER_ATTEMPT = Number(process.env.SPRAY_BLOCKS_PER_ATTEMPT ?? 3);
const SPRAY_MAX_IN_FLIGHT = Number(process.env.SPRAY_MAX_IN_FLIGHT ?? 4);
const SECONDS_PER_BLOCK = Number(process.env.SECONDS_PER_BLOCK ?? 0.3);

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required environment variable ${key} (secrets are runtime-only)`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const guardianKey = requireEnv('GUARDIAN_PRIVATE_KEY') as `0x${string}`;
  const victim = requireEnv('VICTIM_ADDRESS') as `0x${string}`;
  const validatorId = BigInt(requireEnv('VALIDATOR_ID'));
  const withdrawId = Number(process.env.WITHDRAW_ID ?? 0);

  const guardian = privateKeyToAccount(guardianKey);
  const chain = chainById(CHAIN_ID);
  const urls = RPC_POOL[CHAIN_ID] ?? [];

  // Reads go over the lowest-latency transport available; broadcast still fans out to every
  // remote endpoint, because redundancy is free once the transaction is signed.
  const { client, resolved } = await localFirstClient(transportConfigFromEnv(CHAIN_ID));
  const wallet = createWalletClient({ account: guardian, chain, transport: http(urls[0]) });

  console.log(`guardian:   ${guardian.address}`);
  console.log(`victim:     ${victim}`);
  console.log(`read path:  ${resolved.description}`);
  console.log(`broadcast:  ${urls.length} endpoint(s)`);
  if (resolved.kind === 'http-remote') {
    console.log(
      `NOTE: reads are going over the network. Running beside a Monad node and setting\n` +
        `      MONAD_IPC_PATH removes the round-trip that dominates detection latency.`,
    );
  }

  // Refuse to arm against an account with no delegation: the rescue would do nothing.
  const code = await client.getCode({ address: victim });
  const target = delegationTarget(code);
  if (!target) {
    throw new Error(
      `${victim} is not EIP-7702 delegated — the user must complete the approval step first`,
    );
  }
  console.log(`delegated to: ${target}`);

  const req = await getWithdrawalRequest(client, validatorId, victim, withdrawId);
  if (req.withdrawalAmount === 0n) {
    throw new Error(`no pending withdrawal at validator ${validatorId} slot ${withdrawId}`);
  }
  const targetEpoch = req.withdrawEpoch;
  console.log(
    `pending withdrawal: ${formatEther(req.withdrawalAmount)} MON, unlocks at epoch ${targetEpoch}`,
  );
  console.log(`  boundary block: ${boundaryBlockFor(targetEpoch)}`);
  console.log(`  flip window:    ${earliestStartBlockFor(targetEpoch)} .. ${latestStartBlockFor(targetEpoch)}`);

  // Reserve check happens now, while there is time to react — never in the millisecond we fire.
  const startBalance = await client.getBalance({ address: victim });
  const plan = planSweep(startBalance, req.withdrawalAmount);
  console.log(`reserve floor ${formatEther(plan.floor)} MON, sweepable ${formatEther(plan.sweepable)} MON`);
  if (plan.stranded > 0n) {
    console.warn(
      `WARNING: ${formatEther(plan.stranded)} MON will remain stranded on the EOA. Releasing it ` +
        `needs an undelegation followed by 3 quiet blocks — a separate operation.`,
    );
  }
  assertSweepAllowed(startBalance, req.withdrawalAmount, plan.sweepable);

  // Watch for the attacker taking our path away. This runs alongside everything else.
  const stopGuard = watchAccount({
    client, address: victim, expectedDelegate: target, intervalMs: 2_000,
    onThreat: (threats) => {
      for (const t of threats) console.warn(`THREAT ${t.kind}: ${t.detail}`);
    },
  });

  const data = encodeFunctionData({
    abi: MONRESCUE_ABI, functionName: 'rescue', args: [[validatorId], [withdrawId], true],
  });

  const fees = await client.estimateFeesPerGas();
  const multiplier = BigInt(process.env.PRIORITY_FEE_MULTIPLIER ?? 5);
  const gas = BigInt(process.env.GAS_LIMIT ?? 1_000_000);
  const maxFeePerGas = (fees.maxFeePerGas ?? parseGwei('50')) * multiplier;
  const maxPriorityFeePerGas = (fees.maxPriorityFeePerGas ?? parseGwei('2')) * multiplier;

  const safeBaseline = await client.getBalance({
    address: (await client.readContract({
      address: target, abi: MONRESCUE_ABI, functionName: 'SAFE_ADDRESS',
    })) as `0x${string}`,
  });
  const safeAddress = (await client.readContract({
    address: target, abi: MONRESCUE_ABI, functionName: 'SAFE_ADDRESS',
  })) as `0x${string}`;
  const isDone = makeSafeBalanceChecker(client, safeAddress, safeBaseline, 1n);
  console.log(`safe address: ${safeAddress} (baseline ${formatEther(safeBaseline)} MON)`);

  // --- sleep until the window, then spray -----------------------------------
  for (;;) {
    if (await isDone()) {
      console.log('\nsafe address balance increased — the rescue already landed. Done.');
      stopGuard();
      return;
    }

    let epoch, block;
    try {
      [epoch, block] = await Promise.all([getEpoch(client), client.getBlockNumber()]);
    } catch (e) {
      // A dropped poll must never end the watch: this process may need to run for days.
      if (process.env.DEBUG) console.error(`poll error: ${(e as Error).message}`);
      await sleep(MIN_POLL_MS);
      continue;
    }

    const a = advise({
      current: epoch, currentBlock: block, targetEpoch,
      minPollMs: MIN_POLL_MS, secondsPerBlock: SECONDS_PER_BLOCK,
    });

    if (a.phase === 'idle' || a.phase === 'approaching') {
      console.log(`[${a.phase}] ${a.reason}`);
      await sleep(a.pollIntervalMs);
      continue;
    }

    // burst or due: get transactions in flight now.
    console.log(`\n[${a.phase}] ${a.reason}`);

    if (SPRAY_ENABLED) {
      const count = attemptsNeeded(
        Number(latestStartBlockFor(targetEpoch) - earliestStartBlockFor(targetEpoch)) + 40,
        SPRAY_BLOCKS_PER_ATTEMPT,
      );
      const baseNonce = await client.getTransactionCount({ address: guardian.address });
      console.log(`pre-signing ${count} attempts from nonce ${baseNonce}...`);

      const attempts: SprayAttempt[] = [];
      for (let i = 0; i < count; i++) {
        attempts.push({
          nonce: baseNonce + i,
          raw: await wallet.signTransaction({
            to: victim, data, nonce: baseNonce + i, gas,
            maxFeePerGas, maxPriorityFeePerGas, chain,
          }),
        });
      }

      const result = await spray({
        chainId: CHAIN_ID, client, attempts, urls,
        intervalMs: Math.round(SPRAY_BLOCKS_PER_ATTEMPT * SECONDS_PER_BLOCK * 1000),
        maxInFlight: SPRAY_MAX_IN_FLIGHT,
        onAttempt: (nonce, hash, ms) =>
          console.log(`  attempt nonce=${nonce} ${hash ?? 'REJECTED'} (${ms}ms)`),
        isDone,
      });

      console.log(`\nspray finished: ${result.attemptsSent} attempt(s), succeeded=${result.succeeded}`);
      if (result.succeeded) {
        const finalBalance = await client.getBalance({ address: safeAddress });
        console.log(`safe address received ${formatEther(finalBalance - safeBaseline)} MON`);
        stopGuard();
        return;
      }
      console.log('spray exhausted without success — falling back to detect-and-fire');
    }

    // Backstop: the spray is done or disabled, so fire on the observed transition.
    if (isClaimable(epoch, targetEpoch)) {
      const nonce = await client.getTransactionCount({ address: guardian.address });
      const raw = await wallet.signTransaction({
        to: victim, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, chain,
      });
      const { broadcastEverywhere } = await import('./broadcast.js');
      const r = await broadcastEverywhere(CHAIN_ID, raw, urls);
      console.log(`backstop fire: ${r.hash ?? 'all endpoints rejected'}`);
      if (r.hash) {
        const receipt = await client.waitForTransactionReceipt({ hash: r.hash });
        console.log(`receipt: ${receipt.status} in block ${receipt.blockNumber}`);
        stopGuard();
        process.exit(receipt.status === 'success' ? 0 : 1);
      }
    }

    await sleep(a.pollIntervalMs);
  }
}

main().catch((e) => {
  console.error(`\nrescue-cli failed: ${e.message}`);
  process.exit(1);
});
