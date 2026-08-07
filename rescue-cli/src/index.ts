// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, encodeFunctionData, getAddress, isAddress } from 'viem';
import type { SignedAuthorization } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import {
  chainById, RPC_POOL, getEpoch, getWithdrawalRequest, getDelegator, undelegateTiming,
  planSweep, assertSweepAllowed,
  isClaimable, maturityEpoch, isEmptySlot, advise, boundaryBlockFor,
  earliestStartBlockFor, latestStartBlockFor, sprayStartBlockFor,
  localFirstClient, transportConfigFromEnv,
  detectLocalNode,
  discoverUnstakes, validatorIdsFrom, estimateRescueGas,
} from '@monrescue/shared';
import { MONRESCUE_ABI } from './abi.js';
import { broadcastEverywhere } from './broadcast.js';
import { spray, makeSafeBalanceChecker, type SprayAttempt } from './strategies.js';
import { watchAccount, delegationTarget } from './guard.js';
import {
  preflight, gasBudgetFromEnv, attemptsAffordable,
  watchGuardianBalance, GUARDIAN_INFLIGHT_FLOOR,
} from './preflight.js';
import { selectAuthorizations, validateWindow, assessWindow, type AuthorizationWindow } from './authorization.js';
import { observeFees, planFee, feeSchedule, maxSpendPerAttemptFromEnv } from './fees.js';
import { isAbsolute, resolve } from 'node:path';

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
/**
 * Blocks between broadcasts during the flip window. **One**, and the reason is the whole point
 * of pre-queuing.
 *
 * A broadcast attempt is in a leader's mempool for roughly one block before it is included. So
 * one attempt every N blocks means only 1-in-N blocks of the window has a transaction of ours
 * queued when it is built. The default was 3 — covering a third of the window, so two times out
 * of three the flip block would find nothing pre-queued and we would be reacting after all,
 * landing at N+1. That is paying the spray's cost and getting none of its benefit, and it is the
 * frugal-default mistake in its fourth location.
 *
 * At 1 block per attempt the window is fully covered: whenever the flip lands, something of ours
 * is already there. Raise it only to deliberately trade coverage for gas.
 */
const SPRAY_BLOCKS_PER_ATTEMPT = Number(process.env.SPRAY_BLOCKS_PER_ATTEMPT ?? 1);
const SPRAY_MAX_IN_FLIGHT = Number(process.env.SPRAY_MAX_IN_FLIGHT ?? 4);
const SLOTS_TO_PROBE = Number(process.env.SLOTS_TO_PROBE ?? 32);
/** Authorizations carried per attempt. Each costs ~25k gas; all name the same contract. */
const AUTHS_PER_ATTEMPT = Number(process.env.AUTHS_PER_ATTEMPT ?? 6);

/**
 * Resolve a configured path against the repo root rather than the process cwd.
 *
 * `pnpm --filter <pkg> <script>` runs with the cwd set to that package's directory, so a
 * relative path like `./window.json` means a different file depending on which package wrote
 * it and which one reads it. make-window (cwd research/) and arm (cwd rescue-cli/) disagreed
 * about the same configured value, which is not something a user can be expected to debug.
 */
function resolveFromRepoRoot(p: string): string {
  if (isAbsolute(p)) return p;
  return resolve(new URL('../../', import.meta.url).pathname, p);
}

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
  const remoteUrls = RPC_POOL[CHAIN_ID] ?? [];
  if (remoteUrls.length === 0) throw new Error(`no RPC endpoints for chain ${CHAIN_ID}`);

  // Reads take the lowest-latency transport available; broadcast always fans out to every
  // remote endpoint, because redundancy costs nothing once the bytes are signed.
  // Prefer a local node without needing it configured: it is the single biggest latency win,
  // and its absence should be loud rather than a silent 10x regression.
  const local = await detectLocalNode(CHAIN_ID);
  const { client, resolved } = await localFirstClient({
    ...transportConfigFromEnv(CHAIN_ID),
    ...(local.found ? { httpUrl: local.httpUrl, wsUrl: local.wsUrl } : {}),
  });
  // Broadcast through the local node FIRST when there is one. Reads were already local, but
  // submission was going out over the network at 69-261ms measured, while a node answering in
  // single-digit milliseconds sat on the same host — and that node is the one that forwards to
  // the upcoming leaders. Remote endpoints stay in the list behind it as failover.
  const urls = local.found && local.httpUrl ? [local.httpUrl, ...remoteUrls] : remoteUrls;
  const wallet = createWalletClient({ account: guardian, chain, transport: http(urls[0]) });

  console.log(`guardian  ${guardian.address}`);
  console.log(`victim    ${victim}`);
  console.log(`reads     ${resolved.description}`);
  console.log(`node      ${local.detail}`);
  console.log(`broadcast ${urls.length} endpoint(s)${local.found ? ', local first' : ' (all remote)'}`);
  if (!local.found) {
    console.warn(
      `  WARNING: polling a remote endpoint. Detection latency is bounded by that round-trip,\n` +
        `  so a local node is worth roughly 10x here. Set MONAD_HTTP_URL or MONAD_IPC_PATH.`,
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
  if (positions.length === 0) {
    // No withdrawal requests. If there is still ACTIVE stake, nobody has started the clock —
    // the user reached us before the attacker touched the Monad position, which happens when
    // the compromise showed up somewhere else first.
    //
    // Waiting for the attacker to unstake looks acceptable because their event starts our clock
    // either way. It is not: waiting hands them the moment, the slot count, and the boundary.
    // Slot count is the sharpest of the three — `withdrawId` is theirs to pick, each slot needs
    // its own withdraw() call, and 256 of them puts one attempt at ~35 MON against a per-account
    // inflight cap of min(10 MON, balance), which collapses the spray to a single shot. Starting
    // it ourselves takes one slot per validator.
    const active: { validatorId: bigint; stake: bigint }[] = [];
    for (const validatorId of validatorIds) {
      const d = await getDelegator(client, validatorId, victim);
      if (d.stake > 0n) active.push({ validatorId, stake: d.stake });
    }
    if (active.length === 0) {
      throw new Error('no pending withdrawals and no active stake found for those validators');
    }

    const total = active.reduce((a, p) => a + p.stake, 0n);
    const timing = undelegateTiming(await getEpoch(client), await client.getBlockNumber());
    console.log(
      `\nno withdrawal requests, but ${formatEther(total)} MON is still actively staked ` +
        `across ${active.length} validator(s). Nobody has started the clock.`,
    );
    console.log(
      `  unbonding now activates at epoch ${timing.activationEpoch} and matures at ` +
        `${timing.maturityEpoch}` +
        (timing.missedThisBoundary
          ? `  (the boundary for the earlier activation has passed — one extra epoch is unavoidable)`
          : `  (${timing.blocksRemaining} block(s) left to beat the boundary at ` +
            `${timing.deadlineBlock} and save a full epoch)`),
    );

    if ((process.env.START_UNBONDING ?? 'ask') !== 'yes') {
      // Starting the clock is an on-chain action against the user's position with a real,
      // irreversible consequence — their stake stops earning and enters a delay. Fire it
      // deliberately, not as a side effect of running `arm`.
      throw new Error(
        `refusing to unbond without an explicit instruction. Re-run with START_UNBONDING=yes ` +
          `to start the clock, then re-run arm to rescue at maturity.`,
      );
    }

    const slot = Number(process.env.UNBOND_SLOT ?? 0);
    console.log(`\nstarting unbonding into slot ${slot}...`);
    const unbondData = encodeFunctionData({
      abi: MONRESCUE_ABI,
      functionName: 'startUnbonding',
      args: [active.map((p) => p.validatorId), slot],
    });
    const hash = await wallet.sendTransaction({
      to: victim, data: unbondData, gas: 200_000n * BigInt(active.length + 1), chain,
    } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`  ${hash} -> ${receipt.status} in block ${receipt.blockNumber}`);
    if (receipt.status !== 'success') {
      throw new Error('startUnbonding reverted — check UNBOND_SLOT is free and stake is activated');
    }
    console.log(
      `\nclock started. Re-run arm to arm the rescue for epoch ${timing.maturityEpoch}.`,
    );
    return;
  }

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
  // Bid from what the chain is actually paying, not from a multiplier over an estimate.
  // Monad's eth_maxPriorityFeePerGas returns a hardcoded 2 gwei, so a multiplier over it scaled
  // a constant that carries no information about competition. observeFees samples real bids.
  const observed = await observeFees(client, 5);
  // Size the gas limit from the work, not from a fixed default. The previous fixed 350k was
  // chosen for frugality and never checked against the precompile's documented costs; three
  // positions need ~776k, so the transaction ran out of gas and consumed the entire limit
  // producing nothing. Under-sizing is not a partial rescue, it is a total loss of the attempt.
  const claimRewardsToo = (process.env.CLAIM_REWARDS ?? 'auto') !== 'false';
  const gasEstimate = estimateRescueGas(batch.length, claimRewardsToo);
  const gas = BigInt(process.env.GAS_LIMIT ?? gasEstimate.gasLimit);
  console.log(`\ngas limit ${gas}`);
  console.log(`  ${gasEstimate.breakdown}`);
  if (gas < gasEstimate.gasLimit) {
    // Refuse rather than warn. A GAS_LIMIT below the estimate is not a preference — it is the
    // failure that lost the epoch 1035 battle test, and it is invisible when it happens: the
    // transaction is accepted, mined, charged in full, and reverts with `out of gas`, which on
    // Monad is indistinguishable from losing the race because the receipt reports the limit as
    // gasUsed either way. Being long costs the difference; being short costs the position.
    throw new Error(
      `GAS_LIMIT=${gas} is below the computed requirement of ${gasEstimate.gasLimit}.\n` +
        `  A failing precompile call consumes everything forwarded to it, so an under-sized\n` +
        `  limit does not produce a partial rescue — it produces nothing, at full cost.\n` +
        `  Remove GAS_LIMIT from the environment to use the computed value, or set it higher.`,
    );
  }
  const maxSpendPerAttempt = maxSpendPerAttemptFromEnv();
  const feePlan = planFee(observed, gas, maxSpendPerAttempt);
  const maxFeePerGas = feePlan.maxFeePerGas;
  const maxPriorityFeePerGas = feePlan.maxPriorityFeePerGas;
  console.log(`fee: ${feePlan.explanation}`);
  const budget = gasBudgetFromEnv();

  const guardianBalance = await client.getBalance({ address: guardian.address });
  const affordable = attemptsAffordable(budget, gas, maxFeePerGas);
  // Monad caps inflight gas per account at min(10 MON, lagged balance) over 3 blocks, so the
  // number of attempts that can be *in flight* is bounded independently of the budget.
  const inflightCap = Number(
    (guardianBalance < GUARDIAN_INFLIGHT_FLOOR ? guardianBalance : GUARDIAN_INFLIGHT_FLOOR) /
      (gas * maxFeePerGas),
  );
  // Cap by what the guardian can actually pay, not only by the configured budget. Aborting
  // because the budget is larger than the balance is the wrong call: it refuses to attempt a
  // rescue it could still make, just with fewer shots. Keep a margin so the last attempt is
  // not the one that empties the account mid-flight.
  const affordableByBalance = Number((guardianBalance * 9n) / (10n * gas * maxFeePerGas));
  const attemptCount = Math.max(1, Math.min(affordable, affordableByBalance, 64));
  if (affordableByBalance < affordable) {
    console.log(
      `\nguardian balance caps this at ${attemptCount} attempt(s) ` +
        `(budget alone would allow ${Math.min(affordable, 64)}).`,
    );
  }

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
    const path = resolveFromRepoRoot(process.env.AUTH_WINDOW_FILE);
    try {
      window = JSON.parse(readFileSync(path, 'utf8')) as AuthorizationWindow;
    } catch (e) {
      // The window is optional here — arm already warns and continues without one. Dying on a
      // missing file would refuse a rescue we can still make, just without the ability to
      // re-assert delegation if the attacker moves first.
      console.warn(`\ncould not read ${path}: ${(e as Error).message.split('\n')[0]}`);
      console.warn(`  continuing without it. Create one with: pnpm --filter @monrescue/research make-window`);
    }
  }
  if (window) {
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
    args: [batch.map((p) => p.validatorId), batch.map((p) => p.withdrawId), claimRewardsToo],
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
  // How many attempts cover the flip window. Broadcasting starts at sprayStartBlockFor and the
  // epoch must have flipped by latestStartBlockFor, so that span divided by the broadcast
  // cadence is the number of attempts that could each be the one in the decisive block. They
  // are priced identically; only what comes after them escalates.
  const windowBlocks = Number(latestStartBlockFor(targetEpoch) - sprayStartBlockFor(targetEpoch));
  const windowAttempts = Math.max(1, Math.ceil(windowBlocks / SPRAY_BLOCKS_PER_ATTEMPT) + 2);
  const schedule = feeSchedule(observed, gas, maxSpendPerAttempt, attemptCount, windowAttempts);
  const windowCost = schedule
    .slice(0, Math.min(windowAttempts, attemptCount))
    .reduce((a, p) => a + p.costPerAttempt, 0n);
  console.log(
    `fee ladder: ${schedule[0]!.explanation} -> ${schedule[schedule.length - 1]!.explanation}`,
  );
  const covered = Math.min(windowAttempts, attemptCount) * SPRAY_BLOCKS_PER_ATTEMPT;
  console.log(
    `  ${Math.min(windowAttempts, attemptCount)} flat attempt(s) at ${formatEther(windowCost)} MON ` +
      `total cover ${Math.min(100, Math.round((covered / windowBlocks) * 100))}% of the ` +
      `${windowBlocks}-block window; any of them can be the flip block, so all bid the same`,
  );
  if (covered < windowBlocks) {
    // Say it out loud rather than let a silent cap read as full coverage. An uncovered block is
    // one where the flip finds nothing of ours queued and we fall back to reacting.
    console.warn(
      `  WARN: ${windowBlocks - covered} block(s) of the window have no attempt queued. ` +
        `If the flip lands there we react instead of pre-queueing and reach N+1, not N.`,
    );
  }

  const attempts: SprayAttempt[] = [];
  for (let i = 0; i < attemptCount; i++) {
    const step = schedule[i]!;
    attempts.push({
      nonce: baseNonce + i,
      raw: await wallet.signTransaction({
        to: victim, data, nonce: baseNonce + i, gas,
        maxFeePerGas: step.maxFeePerGas,
        maxPriorityFeePerGas: step.maxPriorityFeePerGas,
        chain,
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

  /**
   * Is there still anything to rescue?
   *
   * Two places the money can be, and an earlier version of this only looked at one.
   *
   *  1. Still in a withdrawal slot — claimable by `rescue()`.
   *  2. Already withdrawn INTO the victim EOA — claimable by `sweep()`.
   *
   * Checking only the slots reads "attacker claimed it" as "the funds are gone", when in fact
   * their `withdraw()` pays `msg.sender`, which is this account, which is still delegated to a
   * destination-locked contract. That is not a loss; it is the exact state `sweep()` exists
   * for. At the epoch 1035 battle test this check declared defeat with 114.97 MON sitting on
   * the EOA, recoverable by a single call.
   *
   * A failed read returns false: not knowing is not evidence that the position is gone, and the
   * cost of one more attempt is gas while the cost of quitting early is the position.
   */
  const positionsGone = async (): Promise<boolean> => {
    try {
      for (const p of batch) {
        const r = await getWithdrawalRequest(client, p.validatorId, victim, p.withdrawId);
        if (!isEmptySlot(r.withdrawalAmount, r.withdrawEpoch)) return false;
      }
      // Slots are empty. Is there a sweepable balance sitting on the account?
      const bal = await client.getBalance({ address: victim });
      if (planSweep(bal, 0n).sweepable > 0n) {
        console.log(
          `  slots are empty but ${formatEther(planSweep(bal, 0n).sweepable)} MON is sweepable ` +
            `on the victim — someone withdrew into the account. Run: ` +
            `pnpm --filter @monrescue/rescue-cli sweep`,
        );
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const finish = async (why: string) => {
    stopGuard(); stopBalance();
    const final = await client.getBalance({ address: safeAddress });
    console.log(`\n${why}`);
    console.log(`safe address received ${formatEther(final - safeBaseline)} MON`);
    process.exit(final > safeBaseline ? 0 : 1);
  };

  // --- wait, then burst ---------------------------------------------------
  // The pre-signed attempts are single-use: each carries a fixed nonce, so once the burst has
  // walked the ladder they are spent and re-broadcasting them only costs round-trips at the
  // moment round-trips matter most. After that, retries sign fresh at the current nonce.
  let presignedSpent = false;
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

    // Inside the burst window but not yet at a block where the flip is physically possible.
    // Keep polling at full speed — being late costs the rescue — but do not spend: an attempt
    // broadcast here is a guaranteed revert that burns a ladder rung and its full gas limit.
    if (!a.shouldBroadcast) {
      console.log(
        `[${a.phase}] holding broadcast until block ${a.sprayStart} ` +
          `(${a.sprayStart - block} to go) — the flip cannot happen before it`,
      );
      await sleep(a.pollIntervalMs);
      continue;
    }

    // burst or due. Everything from here is broadcast only.
    console.log(`\n[${a.phase}] ${a.reason}`);

    // One well-timed attempt, or pre-queue across the window?
    //
    // The spray was designed when detection cost ~116ms over remote RPC. Beside a local node
    // it is ~8ms — under 4% of a block — so "detect too slowly to react" is no longer the
    // problem it was built for.
    //
    // What pre-queuing still buys is exactly ONE block: the epoch advances in transaction 0 of
    // the flip block, so a transaction already in the leader's mempool is included in that same
    // block and succeeds, whereas reacting can only reach block N+1. That is decisive only when
    // the attacker reacts rather than pre-queues; if both pre-queue or both react, the fee
    // decides and the spray bought nothing.
    //
    // It is not free: every premature attempt reverts and is charged its full gas limit, so
    // covering the ~40-block uncertainty costs ~2 MON in burnt attempts.
    //
    // Pre-queue anyway, whenever there is a flip to wait for. The loss function is asymmetric:
    // pre-queuing costs ~2 MON and can only ever win a block, while reacting saves ~2 MON and
    // can lose the entire position. We also cannot know in advance whether a rescue is
    // contested — and by the time we could know, it is decided. A rescue exists precisely
    // because someone hostile holds the key, so assuming they are passive is the wrong default.
    //
    // `off` applies only when the position is ALREADY mature: there is no flip to arrive ahead
    // of, so one well-priced attempt now is exactly right and queueing would burn gas for
    // nothing.
    const sprayMode = process.env.SPRAY_MODE ?? (a.phase === 'due' ? 'off' : 'window');
    // Skip the pre-signed set entirely once it has been walked — every nonce in it is consumed,
    // so replaying it costs one rejected round-trip per rung against every endpoint, at the one
    // moment when round-trips are the scarce resource.
    if (!presignedSpent) {
      if (sprayMode === 'off') {
        console.log(`firing a single attempt (SPRAY_MODE=off — reacting, not pre-queueing)`);
        const single = attempts[0]!;
        const t0 = Date.now();
        const r = await broadcastEverywhere(CHAIN_ID, single.raw, urls);
        console.log(`  nonce=${single.nonce} ${r.hash ?? 'REJECTED'} (${Date.now() - t0}ms)`);
        if (r.hash) {
          const receipt = await client.waitForTransactionReceipt({ hash: r.hash });
          console.log(`  receipt ${receipt.status} in block ${receipt.blockNumber}`);
          if (receipt.status === 'success') return finish('rescue landed.');
        }
        console.log(`single attempt did not land — escalating through the ladder`);
      }
      const result = await spray({
        chainId: CHAIN_ID, client, attempts: sprayMode === 'off' ? attempts.slice(1) : attempts, urls,
        intervalMs: Math.round(SPRAY_BLOCKS_PER_ATTEMPT * SECONDS_PER_BLOCK * 1000),
        maxInFlight: Math.max(1, Math.min(SPRAY_MAX_IN_FLIGHT, inflightCap)),
        inflightWindowMs: Math.round(3 * SECONDS_PER_BLOCK * 1000),
        onAttempt: (nonce, hash, ms) =>
          console.log(`  nonce=${nonce} ${hash ?? 'REJECTED'} (${ms}ms)`),
        isDone,
      });
      console.log(`spray: ${result.attemptsSent} attempt(s), succeeded=${result.succeeded}`);
      if (result.succeeded) return finish('rescue landed.');
      presignedSpent = true;
    }

    // Backstop: the spray is exhausted but the epoch has arrived, so sign fresh and fire.
    //
    // A reverted backstop used to end the process. That was wrong, and it is the same mistake
    // as the 350k gas limit and the frugal spray default: it treats one failure as a verdict on
    // a path where giving up early loses the whole position. `rescue()` deliberately does not
    // abort when withdrawals fail — it sweeps regardless — so a revert means the sweep itself
    // found nothing, which is either "the attacker already took it" (over) or "it has not
    // arrived yet" (very much not over). Only the first justifies stopping, and it is
    // distinguishable on-chain: if any slot in the batch still holds a withdrawal request, the
    // money is still there to be claimed.
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
        if (receipt.status === 'success') return finish('backstop landed.');

        if (await positionsGone()) {
          return finish('backstop reverted and every slot is empty — the funds left without us.');
        }
        const affordable = (await client.getBalance({ address: guardian.address })) > gas * maxFeePerGas;
        if (!affordable) {
          return finish('backstop reverted and the guardian cannot afford another attempt — top it up and re-arm.');
        }
        console.log(`backstop reverted but the position is still pending — retrying.`);
      }
    }
    await sleep(a.pollIntervalMs);
  }
}

main().catch((e) => {
  console.error(`\nrescue failed: ${e.message}`);
  process.exit(1);
});
