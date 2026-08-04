import { config as loadEnv } from 'dotenv';
// Load the repo-root .env first, then any package-local one. dotenv never overrides an
// already-set variable, so package-local and real environment variables both win over the root.
loadEnv({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });
loadEnv({ quiet: true });
import { createWalletClient, http, formatEther, encodeFunctionData, getAddress, isAddress } from 'viem';
import type { SignedAuthorization } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import {
  chainById, RPC_POOL, getEpoch, getWithdrawalRequest, planSweep, assertSweepAllowed,
  isClaimable, maturityEpoch, isEmptySlot, advise, boundaryBlockFor,
  earliestStartBlockFor, latestStartBlockFor, localFirstClient, transportConfigFromEnv,
  discoverUnstakes, validatorIdsFrom,
} from '@monrescue/shared';
import { MONRESCUE_ABI } from './abi.js';
import { broadcastEverywhere } from './broadcast.js';
import { spray, makeSafeBalanceChecker, type SprayAttempt } from './strategies.js';
import { watchAccount, delegationTarget } from './guard.js';
import {
  preflight, gasBudgetFromEnv, attemptsAffordable, DEFAULT_RESCUE_GAS_LIMIT,
  watchGuardianBalance, GUARDIAN_INFLIGHT_FLOOR,
} from './preflight.js';
import { selectAuthorizations, validateWindow, assessWindow, type AuthorizationWindow } from './authorization.js';

/**
 * The rescue hot path.
 *
 * Everything expensive happens while there is time; the burst window does nothing but
 * broadcast bytes that were signed minutes earlier.
 *
 * The shape is set by four Phase 0 findings:
 *
 *  - No staking function accepts a recipient, so rescued funds necessarily land on the
 *    compromised EOA and the claim and the sweep must share one transaction.
 *  - The unlock is predictable to ~40 blocks: the boundary block is exactly
 *    (epoch-1) * 50,000 and the epoch begins within EPOCH_DELAY_ROUNDS of it. So we sleep
 *    through hours of waiting and burst only inside the flip window.
 *  - The epoch advances in transaction 0 of the flip block, so a withdraw in that same block
 *    already sees the new epoch. The flip block is the target, not the block after it.
 *  - Ordering is a priority gas auction on total gas price. Latency decides whether we make the
 *    cut for a proposal; the fee decides position within it. So bid high and be early.
 *
 * The guardian key only pays gas. It cannot choose a destination — that is immutable in the
 * contract — and no user key is ever accepted anywhere in this process.
 */

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 143);
const MIN_POLL_MS = Number(process.env.EPOCH_POLL_MS ?? 300);
const SECONDS_PER_BLOCK = Number(process.env.SECONDS_PER_BLOCK ?? 0.301);
const SPRAY_BLOCKS_PER_ATTEMPT = Number(process.env.SPRAY_BLOCKS_PER_ATTEMPT ?? 3);
const SPRAY_MAX_IN_FLIGHT = Number(process.env.SPRAY_MAX_IN_FLIGHT ?? 4);
const SLOTS_TO_PROBE = Number(process.env.SLOTS_TO_PROBE ?? 32);
/** Authorizations carried per attempt. Each costs ~25k gas; all name the same contract. */
const AUTHS_PER_ATTEMPT = Number(process.env.AUTHS_PER_ATTEMPT ?? 6);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required environment variable ${key} (secrets are runtime-only)`);
  return v;
}

async function main() {
  const guardianKey = requireEnv('GUARDIAN_PRIVATE_KEY') as `0x${string}`;
  const victimRaw = requireEnv('VICTIM_ADDRESS');
  if (!isAddress(victimRaw)) throw new Error(`VICTIM_ADDRESS is not an address: ${victimRaw}`);
  const victim = getAddress(victimRaw);

  const guardian = privateKeyToAccount(guardianKey);
  const chain = chainById(CHAIN_ID);
  const urls = RPC_POOL[CHAIN_ID] ?? [];
  if (urls.length === 0) throw new Error(`no RPC endpoints for chain ${CHAIN_ID}`);

  // Reads take the lowest-latency transport available; broadcast always fans out to every
  // remote endpoint, because redundancy costs nothing once the bytes are signed.
  const { client, resolved } = await localFirstClient(transportConfigFromEnv(CHAIN_ID));
  const wallet = createWalletClient({ account: guardian, chain, transport: http(urls[0]) });

  console.log(`guardian  ${guardian.address}`);
  console.log(`victim    ${victim}`);
  console.log(`reads     ${resolved.description}`);
  console.log(`broadcast ${urls.length} endpoint(s)`);
  if (resolved.kind === 'http-remote') {
    console.log(
      `  NOTE: reads are crossing the network. Running beside a Monad node and setting\n` +
        `  MONAD_IPC_PATH removes the round-trip that dominates detection latency.`,
    );
  }

  // --- delegation ---------------------------------------------------------
  const code = await client.getCode({ address: victim });
  const target = delegationTarget(code);
  if (!target) {
    throw new Error(`${victim} is not delegated — run the emergency intake first`);
  }
  const rescueContract = getAddress(target);
  const safeAddress = (await client.readContract({
    address: rescueContract, abi: MONRESCUE_ABI, functionName: 'SAFE_ADDRESS',
  })) as `0x${string}`;
  console.log(`contract  ${rescueContract}`);
  console.log(`safe      ${safeAddress}`);

  // --- positions ----------------------------------------------------------
  // Default to discovering everything from the Undelegate events themselves. The unstake
  // transaction — usually the attacker's — already carries the validator, the slot, the amount
  // and the maturity epoch, so there is nothing for an operator to type under time pressure,
  // and nothing to get wrong. VALIDATOR_IDS stays as an override for when the event is older
  // than the log lookback or the RPC will not serve the range.
  let validatorIds: bigint[];
  if (process.env.VALIDATOR_IDS) {
    validatorIds = process.env.VALIDATOR_IDS.split(',').map((s) => BigInt(s.trim()));
    console.log(`\nvalidators (from VALIDATOR_IDS): ${validatorIds.join(', ')}`);
  } else {
    console.log(`\ndiscovering positions from Undelegate events...`);
    const events = await discoverUnstakes(client, victim);
    validatorIds = validatorIdsFrom(events);
    for (const e of events) {
      console.log(
        `  ${e.txHash.slice(0, 12)}… block ${e.blockNumber}: validator ${e.validatorId} ` +
          `slot ${e.withdrawId}, ${formatEther(e.amount)} MON, matures epoch ${e.maturesAtEpoch}`,
      );
    }
    if (validatorIds.length === 0) {
      throw new Error(
        'no Undelegate events found for this account in the lookback window. ' +
          'Pass VALIDATOR_IDS=<ids> to probe slots directly.',
      );
    }
  }
  const positions: { validatorId: bigint; withdrawId: number; amount: bigint; maturesAt: bigint }[] = [];
  for (const validatorId of validatorIds) {
    for (let slot = 0; slot < SLOTS_TO_PROBE; slot++) {
      const r = await getWithdrawalRequest(client, validatorId, victim, slot);
      if (isEmptySlot(r.withdrawalAmount, r.withdrawEpoch)) continue;
      positions.push({
        validatorId, withdrawId: slot,
        amount: r.withdrawalAmount,
        maturesAt: maturityEpoch(r.withdrawEpoch),
      });
    }
  }
  if (positions.length === 0) throw new Error('no pending withdrawals found for those validators');

  // Batch everything maturing at the earliest epoch into ONE rescue() call. Positions maturing
  // later need their own run — including them here would mean waiting for the latest and
  // conceding the earlier ones.
  const targetEpoch = positions.reduce((m, p) => (p.maturesAt < m ? p.maturesAt : m), positions[0]!.maturesAt);
  const batch = positions.filter((p) => p.maturesAt === targetEpoch);
  const later = positions.filter((p) => p.maturesAt !== targetEpoch);
  const totalAmount = batch.reduce((a, p) => a + p.amount, 0n);

  console.log(`\ntarget epoch ${targetEpoch}, ${batch.length} position(s), ${formatEther(totalAmount)} MON`);
  for (const p of batch) {
    console.log(`  validator ${p.validatorId} slot ${p.withdrawId}: ${formatEther(p.amount)} MON`);
  }
  if (later.length > 0) {
    console.log(`  (${later.length} position(s) mature later — run again for epoch ${later[0]!.maturesAt})`);
  }
  console.log(`boundary ${boundaryBlockFor(targetEpoch)}, flip window ` +
    `${earliestStartBlockFor(targetEpoch)}..${latestStartBlockFor(targetEpoch)}`);

  // --- reserve check, now rather than as an on-chain revert ---------------
  const startBalance = await client.getBalance({ address: victim });
  const plan = planSweep(startBalance, totalAmount);
  console.log(`\nreserve floor ${formatEther(plan.floor)} MON, sweepable ${formatEther(plan.sweepable)} MON`);
  if (plan.stranded > 0n) {
    console.warn(`  ${formatEther(plan.stranded)} MON will be stranded; releasing it needs an ` +
      `undelegation and 3 quiet blocks, as a separate operation.`);
  }
  assertSweepAllowed(startBalance, totalAmount, plan.sweepable);

  // --- fees and budget ----------------------------------------------------
  // eth_maxPriorityFeePerGas is a hardcoded 2 gwei on Monad rather than a live oracle, so it is
  // a floor to multiply up from, not a recommendation to trust.
  const fees = await client.estimateFeesPerGas();
  const multiplier = BigInt(process.env.PRIORITY_FEE_MULTIPLIER ?? 20);
  const gas = BigInt(process.env.GAS_LIMIT ?? DEFAULT_RESCUE_GAS_LIMIT);
  const maxFeePerGas = (fees.maxFeePerGas ?? 100_000_000_000n) * multiplier;
  const maxPriorityFeePerGas = (fees.maxPriorityFeePerGas ?? 2_000_000_000n) * multiplier;
  const budget = gasBudgetFromEnv();

  const guardianBalance = await client.getBalance({ address: guardian.address });
  const affordable = attemptsAffordable(budget, gas, maxFeePerGas);
  // Monad caps inflight gas per account at min(10 MON, lagged balance) over 3 blocks, so the
  // number of attempts that can be *in flight* is bounded independently of the budget.
  const inflightCap = Number(
    (guardianBalance < GUARDIAN_INFLIGHT_FLOOR ? guardianBalance : GUARDIAN_INFLIGHT_FLOOR) /
      (gas * maxFeePerGas),
  );
  const attemptCount = Math.max(1, Math.min(affordable, 64));

  const pf = await preflight({
    client, guardian: guardian.address, victim, gas, maxFeePerGas, plannedAttempts: attemptCount,
  });
  for (const w of pf.warnings) console.warn(`WARN: ${w}`);
  for (const e of pf.errors) console.error(`ERROR: ${e}`);
  if (!pf.ok) throw new Error('preflight failed');

  console.log(
    `\nbudget ${formatEther(budget)} MON -> ${attemptCount} attempt(s) at ${gas} gas ` +
      `x ${formatEther(maxFeePerGas)} MON/gas (inflight cap ~${inflightCap})`,
  );

  // --- authorization window (optional, for re-asserting delegation) -------
  let window: AuthorizationWindow | undefined;
  if (process.env.AUTH_WINDOW_FILE) {
    window = JSON.parse(readFileSync(process.env.AUTH_WINDOW_FILE, 'utf8')) as AuthorizationWindow;
    validateWindow(window, CHAIN_ID, rescueContract);
    const victimNonce = await client.getTransactionCount({ address: victim });
    console.log(`\nauthorization window: ${assessWindow(window, victimNonce).message}`);
  } else {
    console.warn(
      `\nNo AUTH_WINDOW_FILE. If the attacker re-delegates the account before the unlock, the\n` +
        `pre-signed rescue becomes a call into THEIR code and we cannot re-assert. Strongly\n` +
        `recommended for a contested rescue.`,
    );
  }

  // --- PRE-SIGN NOW, while there is time ----------------------------------
  // The whole point. Signing inside the flip window would spend milliseconds at the exact
  // moment they are most expensive, which is the mistake this design exists to avoid.
  const data = encodeFunctionData({
    abi: MONRESCUE_ABI,
    functionName: 'rescue',
    args: [batch.map((p) => p.validatorId), batch.map((p) => p.withdrawId), true],
  });

  const baseNonce = await client.getTransactionCount({ address: guardian.address });
  const victimNonce = await client.getTransactionCount({ address: victim });
  // Carry a slice of the window in every attempt. The authorization list is processed BEFORE
  // the top-level call, so each attempt re-asserts our delegation and then rescues, atomically.
  // Several are included because the attacker can bump the victim's nonce between now and the
  // flip; all of them name the same destination-locked contract, so whether one applies or all
  // do, the outcome is identical.
  const authorizationList: SignedAuthorization[] | undefined = window
    ? selectAuthorizations(window, victimNonce, AUTHS_PER_ATTEMPT)
    : undefined;
  if (authorizationList) {
    console.log(`carrying ${authorizationList.length} authorization(s) per attempt`);
  }

  console.log(`pre-signing ${attemptCount} attempt(s) from nonce ${baseNonce}...`);
  const t0 = Date.now();
  const attempts: SprayAttempt[] = [];
  for (let i = 0; i < attemptCount; i++) {
    attempts.push({
      nonce: baseNonce + i,
      raw: await wallet.signTransaction({
        to: victim, data, nonce: baseNonce + i, gas,
        maxFeePerGas, maxPriorityFeePerGas, chain,
        ...(authorizationList ? { authorizationList } : {}),
      } as never),
    });
  }
  console.log(`pre-signed in ${Date.now() - t0}ms — the flip window will only broadcast`);

  // --- watchers -----------------------------------------------------------
  const stopGuard = watchAccount({
    client, address: victim, expectedDelegate: rescueContract, intervalMs: 2_000,
    onThreat: (threats) => {
      for (const t of threats) {
        console.warn(`THREAT ${t.kind}: ${t.detail}`);
        if (!t.rescueStillArmed && !authorizationList) {
          console.warn(`  no authorization window loaded — cannot re-assert. Re-arm manually.`);
        }
      }
    },
  });
  const stopBalance = watchGuardianBalance(
    client, guardian.address, gas * maxFeePerGas * 4n, 10_000,
    (b) => console.warn(`WARN: guardian down to ${formatEther(b)} MON — top it up now`),
  );

  const safeBaseline = await client.getBalance({ address: safeAddress });
  const isDone = makeSafeBalanceChecker(client, safeAddress, safeBaseline, 1n);
  console.log(`safe baseline ${formatEther(safeBaseline)} MON`);

  const finish = async (why: string) => {
    stopGuard(); stopBalance();
    const final = await client.getBalance({ address: safeAddress });
    console.log(`\n${why}`);
    console.log(`safe address received ${formatEther(final - safeBaseline)} MON`);
    process.exit(final > safeBaseline ? 0 : 1);
  };

  // --- wait, then burst ---------------------------------------------------
  console.log(`\narmed. waiting for epoch ${targetEpoch}...`);
  for (;;) {
    if (await isDone()) return finish('safe address balance increased — rescue landed.');

    let epoch, block;
    try {
      [epoch, block] = await Promise.all([getEpoch(client), client.getBlockNumber()]);
    } catch (e) {
      if (process.env.DEBUG) console.error(`poll: ${(e as Error).message}`);
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

    // burst or due. Everything from here is broadcast only.
    console.log(`\n[${a.phase}] ${a.reason}`);
    const result = await spray({
      chainId: CHAIN_ID, client, attempts, urls,
      intervalMs: Math.round(SPRAY_BLOCKS_PER_ATTEMPT * SECONDS_PER_BLOCK * 1000),
      maxInFlight: Math.max(1, Math.min(SPRAY_MAX_IN_FLIGHT, inflightCap)),
      onAttempt: (nonce, hash, ms) =>
        console.log(`  nonce=${nonce} ${hash ?? 'REJECTED'} (${ms}ms)`),
      isDone,
    });
    console.log(`spray: ${result.attemptsSent} attempt(s), succeeded=${result.succeeded}`);
    if (result.succeeded) return finish('rescue landed.');

    // Backstop: the spray is exhausted but the epoch has arrived, so sign fresh and fire.
    if (isClaimable(epoch, targetEpoch - 1n) || epoch.epoch >= targetEpoch) {
      const nonce = await client.getTransactionCount({ address: guardian.address });
      const raw = await wallet.signTransaction({
        to: victim, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, chain,
        ...(authorizationList ? { authorizationList } : {}),
      } as never);
      const r = await broadcastEverywhere(CHAIN_ID, raw, urls);
      console.log(`backstop: ${r.hash ?? 'rejected by every endpoint'}`);
      if (r.hash) {
        const receipt = await client.waitForTransactionReceipt({ hash: r.hash });
        console.log(`receipt ${receipt.status} in block ${receipt.blockNumber}`);
        return finish(receipt.status === 'success' ? 'backstop landed.' : 'backstop reverted.');
      }
    }
    await sleep(a.pollIntervalMs);
  }
}

main().catch((e) => {
  console.error(`\nrescue failed: ${e.message}`);
  process.exit(1);
});
