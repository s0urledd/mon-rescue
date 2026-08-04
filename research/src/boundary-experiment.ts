/**
 * Boundary-block A/B experiment.
 *
 * Settles, empirically and in one run, the question the documentation contradicts itself on:
 * what does `withdrawEpoch` actually record, and does the boundary block really move maturity
 * by a full epoch?
 *
 * Two undelegates of the same size, in the SAME epoch `n`, on different withdrawId slots:
 *
 *   A — fired BEFORE the boundary block (inEpochDelayPeriod == false)
 *   B — fired AFTER  the boundary block (inEpochDelayPeriod == true)
 *
 * Predictions, from the implementation rather than the docs:
 *
 *   A -> withdrawEpoch = n+1, claimable at n+2
 *   B -> withdrawEpoch = n+2, claimable at n+3
 *
 * If instead both record `n`, the docs' `undelegate` pseudocode (`epoch = getEpoch()`) is right
 * and our `maturityEpoch()` is wrong — which would mean firing an epoch late, not early.
 *
 * Why this is automated rather than done by hand: the window for B is only EPOCH_DELAY_ROUNDS
 * wide, measured at 4,962-4,999 blocks, i.e. about 25 minutes. Missing it wastes a day, because
 * the next boundary is ~4.2h away and each test then needs its own unbonding period.
 *
 *   PHASE=a   fire the before-boundary leg now, then exit
 *   PHASE=b   wait for the boundary to pass, then fire the after-boundary leg automatically
 *   PHASE=ab  do both: fire A now, wait for the boundary, fire B  (recommended)
 *   PHASE=report  read both slots back and compare against predictions
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
  getEpoch, getWithdrawalRequest, getDelegator, maturityEpoch,
  boundaryBlockFor, type EpochState,
} from '@monrescue/shared';
import { writeArtifact, requireEnv } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const PHASE = (process.env.PHASE ?? 'ab').toLowerCase();
const SLOT_A = Number(process.env.SLOT_A ?? 0);
const SLOT_B = Number(process.env.SLOT_B ?? 1);
const POLL_MS = Number(process.env.POLL_MS ?? 2000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Leg {
  label: 'A-before-boundary' | 'B-after-boundary';
  slot: number;
  firedAtBlock: string;
  firedInEpoch: string;
  inEpochDelayPeriodAtFire: boolean;
  txHash: string;
  status: string;
  predictedWithdrawEpoch: string;
  actualWithdrawEpoch: string;
  predictedMaturity: string;
  actualMaturity: string;
  amountRequested: string;
  amountRecorded: string;
  matchedPrediction: boolean;
}

async function fireLeg(
  label: Leg['label'],
  slot: number,
  amount: bigint,
  validatorId: bigint,
  ctx: Awaited<ReturnType<typeof setup>>,
): Promise<Leg> {
  const { client, wallet, account } = ctx;

  const existing = await getWithdrawalRequest(client, validatorId, account.address, slot);
  if (existing.withdrawalAmount > 0n) {
    throw new Error(
      `slot ${slot} already holds ${formatEther(existing.withdrawalAmount)} MON — pick a free slot`,
    );
  }

  const before = await getEpoch(client);
  const block = await client.getBlockNumber();
  // The prediction under test: activation is n+1 before the boundary, n+2 after it.
  const predicted = before.epoch + (before.inEpochDelayPeriod ? 2n : 1n);

  console.log(`\n--- ${label} ---`);
  console.log(`  block ${block}, epoch ${before.epoch}, inEpochDelayPeriod=${before.inEpochDelayPeriod}`);
  console.log(`  predicting withdrawEpoch=${predicted}, maturity=${maturityEpoch(predicted)}`);

  const data = encodeFunctionData({
    abi: STAKING_ABI, functionName: 'undelegate', args: [validatorId, amount, slot],
  });
  const hash = await wallet.sendTransaction({ to: STAKING_PRECOMPILE, data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`  ${hash} -> ${receipt.status} in block ${receipt.blockNumber}`);

  const actual = await getWithdrawalRequest(client, validatorId, account.address, slot);
  const matched = actual.withdrawEpoch === predicted;
  console.log(
    `  on-chain withdrawEpoch=${actual.withdrawEpoch} ` +
      `${matched ? '(matches prediction)' : '!! DIFFERS FROM PREDICTION'}`,
  );
  // The dust sweep can silently enlarge the request beyond what was asked for, so read it back.
  if (actual.withdrawalAmount !== amount) {
    console.log(
      `  NOTE: recorded amount ${formatEther(actual.withdrawalAmount)} != requested ` +
        `${formatEther(amount)} — the dust sweep folds a sub-1-gwei remainder into the request.`,
    );
  }

  return {
    label, slot,
    firedAtBlock: receipt.blockNumber.toString(),
    firedInEpoch: before.epoch.toString(),
    inEpochDelayPeriodAtFire: before.inEpochDelayPeriod,
    txHash: hash,
    status: receipt.status,
    predictedWithdrawEpoch: predicted.toString(),
    actualWithdrawEpoch: actual.withdrawEpoch.toString(),
    predictedMaturity: maturityEpoch(predicted).toString(),
    actualMaturity: maturityEpoch(actual.withdrawEpoch).toString(),
    amountRequested: amount.toString(),
    amountRecorded: actual.withdrawalAmount.toString(),
    matchedPrediction: matched,
  };
}

/** Block-poll until the boundary block has passed, i.e. inEpochDelayPeriod flips true. */
async function waitForBoundary(
  client: Awaited<ReturnType<typeof setup>>['client'],
  startedIn: EpochState,
): Promise<void> {
  const target = boundaryBlockFor(startedIn.epoch + 1n);
  console.log(`\nwaiting for boundary block ${target} (epoch ${startedIn.epoch} -> delay period)...`);
  for (;;) {
    const [epoch, block] = await Promise.all([getEpoch(client), client.getBlockNumber()]);
    if (epoch.epoch > startedIn.epoch) {
      throw new Error(
        `epoch already advanced to ${epoch.epoch} — the delay window was missed. ` +
          `Re-run PHASE=b at the next boundary.`,
      );
    }
    if (epoch.inEpochDelayPeriod) {
      console.log(`boundary passed at block ${block} — now in the delay period`);
      return;
    }
    const remaining = target > block ? target - block : 0n;
    if (remaining % 500n === 0n || remaining < 20n) {
      console.log(
        `  block ${block}, ${remaining} to go (~${((Number(remaining) * 0.301) / 60).toFixed(1)} min)`,
      );
    }
    await sleep(POLL_MS);
  }
}

async function setup() {
  const pk = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const client = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });
  return { account, client, wallet };
}

async function main() {
  const ctx = await setup();
  const validatorId = BigInt(requireEnv('VALIDATOR_ID'));
  const amount = parseEther(process.env.AMOUNT ?? '1');

  const epoch = await getEpoch(ctx.client);
  const block = await ctx.client.getBlockNumber();
  console.log(`=== boundary A/B experiment ===`);
  console.log(`account ${ctx.account.address}`);
  console.log(`epoch ${epoch.epoch} inEpochDelayPeriod=${epoch.inEpochDelayPeriod} block ${block}`);

  if (PHASE === 'report') {
    const legs = [];
    for (const [label, slot] of [['A-before-boundary', SLOT_A], ['B-after-boundary', SLOT_B]] as const) {
      const r = await getWithdrawalRequest(ctx.client, validatorId, ctx.account.address, slot);
      legs.push({ label, slot, withdrawEpoch: r.withdrawEpoch, maturity: maturityEpoch(r.withdrawEpoch), amount: r.withdrawalAmount });
      console.log(
        `\n${label} (slot ${slot}): amount=${formatEther(r.withdrawalAmount)} MON ` +
          `withdrawEpoch=${r.withdrawEpoch} maturity=${maturityEpoch(r.withdrawEpoch)}`,
      );
    }
    const delta = legs[1]!.withdrawEpoch - legs[0]!.withdrawEpoch;
    console.log(`\ndelta between B and A: ${delta} epoch(s)`);
    console.log(
      delta === 1n
        ? `CONFIRMED: crossing the boundary block costs exactly one epoch (~4.2h).`
        : `UNEXPECTED delta — record this in FINDINGS.md, the on-chain value is authoritative.`,
    );
    await writeArtifact('boundary-experiment-report', {
      chainId: CHAIN_ID, validatorId: validatorId.toString(),
      legs: legs.map((l) => ({ ...l, withdrawEpoch: l.withdrawEpoch.toString(), maturity: l.maturity.toString(), amount: l.amount.toString() })),
      deltaEpochs: delta.toString(),
    });
    return;
  }

  const del = await getDelegator(ctx.client, validatorId, ctx.account.address);
  console.log(`active stake ${formatEther(del.stake)} MON`);
  const needed = PHASE === 'ab' ? amount * 2n : amount;
  if (del.stake < needed) {
    throw new Error(
      `need ${formatEther(needed)} MON of ACTIVE stake for this phase, have ${formatEther(del.stake)}. ` +
        `Note only activated stake can be undelegated — a delegation made this epoch is not yet active.`,
    );
  }

  const legs: Leg[] = [];

  if (PHASE === 'a' || PHASE === 'ab') {
    if (epoch.inEpochDelayPeriod) {
      throw new Error(
        `already past the boundary block, so leg A cannot be fired in this epoch. ` +
          `Wait for epoch ${epoch.epoch + 1n} and re-run.`,
      );
    }
    legs.push(await fireLeg('A-before-boundary', SLOT_A, amount, validatorId, ctx));
  }

  if (PHASE === 'b' || PHASE === 'ab') {
    const now = await getEpoch(ctx.client);
    if (!now.inEpochDelayPeriod) await waitForBoundary(ctx.client, now);
    legs.push(await fireLeg('B-after-boundary', SLOT_B, amount, validatorId, ctx));
  }

  console.log(`\n=== result ===`);
  for (const l of legs) {
    console.log(
      `${l.label}: fired in epoch ${l.firedInEpoch} (delayPeriod=${l.inEpochDelayPeriodAtFire}) ` +
        `-> withdrawEpoch ${l.actualWithdrawEpoch}, claimable at ${l.actualMaturity}`,
    );
  }
  if (legs.length === 2) {
    const delta = BigInt(legs[1]!.actualWithdrawEpoch) - BigInt(legs[0]!.actualWithdrawEpoch);
    console.log(`\ndelta: ${delta} epoch(s) — ${delta === 1n ? 'boundary costs exactly one epoch' : 'UNEXPECTED'}`);
  }
  if (legs.some((l) => !l.matchedPrediction)) {
    console.log(
      `\nAt least one leg differed from the prediction. The on-chain value is authoritative: ` +
        `update maturityEpoch() and FINDINGS.md Q11 to match.`,
    );
  }

  await writeArtifact('boundary-experiment', { chainId: CHAIN_ID, validatorId: validatorId.toString(), phase: PHASE, legs });
}

main().catch((e) => { console.error(`\nboundary-experiment failed: ${e.message}`); process.exit(1); });
