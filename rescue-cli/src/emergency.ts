/**
 * Emergency intake: compromised address -> armed, in one command.
 *
 * The primary flow. A user shows up already compromised with no delegation, no contract and
 * nothing pre-signed, and the only thing that matters is time-to-armed.
 *
 * What this does NOT do: ask for a seed phrase or a private key. The user's only inputs are
 * signatures made in their own wallet, supplied here as a JSON file produced by the approval
 * page. There is no code path in this repository that accepts a protected user's key.
 *
 *   AUTH_WINDOW_FILE=./window.json pnpm --filter @monrescue/rescue-cli emergency
 */
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import {
  chainById, RPC_POOL, publicClientFor, getEpoch, getWithdrawalRequest, getDelegations,
  isClaimable, epochsUntilClaimable, maturityEpoch, isEmptySlot,
  boundaryBlockFor, earliestStartBlockFor, latestStartBlockFor, undelegateTiming,
} from '@monrescue/shared';
import { MONRESCUE_ABI } from './abi.js';
import { validateWindow, assessWindow, type AuthorizationWindow } from './authorization.js';
import { delegationTarget } from './guard.js';
import { preflight, gasBudgetFromEnv, DEFAULT_RESCUE_GAS_LIMIT } from './preflight.js';
import { isAbsolute, resolve } from 'node:path';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 143);

/** Slots to probe per validator. getWithdrawalRequest is safe on empty slots; withdraw is not. */
const SLOTS_TO_PROBE = 32;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing ${key}`);
  return v;
}

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

export interface Position {
  validatorId: bigint;
  withdrawId: number;
  amount: bigint;
  withdrawEpoch: bigint;
  maturesAt: bigint;
  epochsRemaining: bigint;
  claimableNow: boolean;
}

/**
 * Find every claimable or maturing position.
 *
 * Deliberately does not trust getDelegations alone: the precompile drops a delegator from that
 * list once their next-epoch stake hits zero, while their pending withdrawals remain live. A
 * fully-unbonded user — the exact case here — is invisible to it.
 */
export async function findPositions(
  client: Awaited<ReturnType<typeof publicClientFor>>,
  victim: `0x${string}`,
  extraValidatorIds: readonly bigint[] = [],
): Promise<Position[]> {
  const epoch = await getEpoch(client);
  const discovered = await getDelegations(client, victim).catch(() => [] as bigint[]);
  const ids = [...new Set([...discovered, ...extraValidatorIds])];

  const out: Position[] = [];
  for (const validatorId of ids) {
    for (let slot = 0; slot < SLOTS_TO_PROBE; slot++) {
      const req = await getWithdrawalRequest(client, validatorId, victim, slot);
      if (isEmptySlot(req.withdrawalAmount, req.withdrawEpoch)) continue;
      out.push({
        validatorId,
        withdrawId: slot,
        amount: req.withdrawalAmount,
        withdrawEpoch: req.withdrawEpoch,
        maturesAt: maturityEpoch(req.withdrawEpoch),
        epochsRemaining: epochsUntilClaimable(epoch, req.withdrawEpoch),
        claimableNow: isClaimable(epoch, req.withdrawEpoch),
      });
    }
  }
  return out;
}

async function main() {
  const guardianKey = requireEnv('GUARDIAN_PRIVATE_KEY') as `0x${string}`;
  const victimRaw = requireEnv('VICTIM_ADDRESS');
  if (!isAddress(victimRaw)) throw new Error(`VICTIM_ADDRESS is not an address: ${victimRaw}`);
  const victim = getAddress(victimRaw);

  const guardian = privateKeyToAccount(guardianKey);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const client = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account: guardian, chain, transport: http(url) });

  console.log(`=== MonRescue emergency intake ===`);
  console.log(`chain ${CHAIN_ID}  victim ${victim}  guardian ${guardian.address}\n`);

  // --- 1. triage: what is actually still saveable? ------------------------
  const epoch = await getEpoch(client);
  const victimBalance = await client.getBalance({ address: victim });
  const extraIds = (process.env.VALIDATOR_IDS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(BigInt);

  console.log(`epoch ${epoch.epoch}${epoch.inEpochDelayPeriod ? ' (in delay period)' : ''}`);
  console.log(`victim balance ${formatEther(victimBalance)} MON`);
  console.log(`probing positions...`);

  const positions = await findPositions(client, victim, extraIds);

  // The boundary-block lever, printed BEFORE anything can return early — this advice matters
  // most in exactly the case where there are no positions yet, i.e. the stake is still bonded
  // and someone is about to undelegate.
  //
  // The snapshot for the next epoch is taken at the START of the boundary block, before user
  // transactions. So an undelegate landing before that block activates at n+1 and matures at
  // n+2; one landing in the boundary block or later matures at n+3. That is a full epoch,
  // roughly 4.2 hours, decided by which side of a single block the transaction lands on. It is
  // the largest lever on the clock and it is completely invisible unless you look for it.
  const nowBlock = await client.getBlockNumber();
  const timing = undelegateTiming(epoch, nowBlock);
  console.log(`\nundelegate timing (block ${nowBlock}):`);
  console.log(`  undelegating now activates epoch ${timing.activationEpoch}, matures epoch ${timing.maturityEpoch}`);
  if (timing.missedThisBoundary) {
    console.log(
      `  past this epoch's boundary block — the extra epoch is already unavoidable for anything\n` +
        `  undelegated now. Next boundary is block ${timing.deadlineBlock}.`,
    );
  } else {
    const hours = (Number(timing.blocksRemaining) * 0.301) / 3600;
    console.log(
      `  DEADLINE: land the undelegate before block ${timing.deadlineBlock} ` +
        `(~${timing.blocksRemaining} blocks, ~${hours.toFixed(2)}h).\n` +
        `  Missing it costs a full epoch (~4.2h) of extra waiting.`,
    );
  }

  if (positions.length === 0 && victimBalance === 0n) {
    console.log(`\nNo pending withdrawals and no liquid balance.`);
    console.log(`If stake is still bonded, someone has to undelegate to start the clock — that is`);
    console.log(`what makes it rescuable at all. Use the deadline above.`);
    console.log(`If getDelegations came back empty, pass VALIDATOR_IDS=... explicitly: the`);
    console.log(`precompile drops delegators from that list once next-epoch stake hits zero.`);
    return;
  }

  let live = 0n;
  console.log(`\npositions:`);
  for (const p of positions) {
    live += p.amount;
    console.log(
      `  validator ${p.validatorId} slot ${p.withdrawId}: ${formatEther(p.amount)} MON, ` +
        (p.claimableNow
          ? `CLAIMABLE NOW`
          : `matures at epoch ${p.maturesAt} (${p.epochsRemaining} to go, ~${Number(p.epochsRemaining) * 4.2}h)`),
    );
  }
  if (victimBalance > 0n) {
    console.log(`  liquid on EOA: ${formatEther(victimBalance)} MON (sweepable above the reserve floor)`);
  }
  console.log(`\ntotal in pending withdrawals: ${formatEther(live)} MON`);

  // --- 2. the setup window ------------------------------------------------
  const soonest = positions.filter((p) => !p.claimableNow).sort((a, b) =>
    a.maturesAt < b.maturesAt ? -1 : 1,
  )[0];
  if (soonest) {
    const boundary = boundaryBlockFor(soonest.maturesAt);
    const block = await client.getBlockNumber();
    const blocksLeft = boundary > block ? boundary - block : 0n;
    console.log(
      `\nsoonest unlock: epoch ${soonest.maturesAt}, boundary block ${boundary}, ` +
        `flip window ${earliestStartBlockFor(soonest.maturesAt)}..${latestStartBlockFor(soonest.maturesAt)}`,
    );
    console.log(
      `setup time available: ~${blocksLeft} blocks (~${(Number(blocksLeft) * 0.301 / 3600).toFixed(2)}h)`,
    );
  }
  if (positions.some((p) => p.claimableNow)) {
    console.log(`\nWARNING: a position is claimable RIGHT NOW. Arm immediately — there is no runway.`);
  }

  // --- 3. authorization window -------------------------------------------
  const windowFile = process.env.AUTH_WINDOW_FILE;
  if (!windowFile) {
    console.log(`\nNo AUTH_WINDOW_FILE set — triage only, not arming.`);
    console.log(`Next: have the user sign an authorization window in their own wallet via the`);
    console.log(`approval page, save it to JSON, and re-run with AUTH_WINDOW_FILE=...`);
    return;
  }

  let window: AuthorizationWindow;
  try {
    window = JSON.parse(readFileSync(resolveFromRepoRoot(windowFile), 'utf8')) as AuthorizationWindow;
  } catch (e) {
    // Triage above this point is already useful, so a missing window must not discard it.
    // AUTH_WINDOW_FILE is set in .env by default, which means the natural first run lands here.
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    console.log(`\n${missing ? `No authorization window at ${windowFile} yet.` : `Could not read ${windowFile}: ${(e as Error).message}`}`);
    console.log(`Triage above is complete. To arm, create the window first:`);
    console.log(`\n  pnpm --filter @monrescue/research make-window\n`);
    console.log(`Or unset AUTH_WINDOW_FILE to run triage only.`);
    return;
  }
  const rescueContract = getAddress(window.contractAddress);

  // Refuse a window that does not match this chain or this contract, and refuse chainId 0
  // outright — it is valid on every chain and never expires.
  validateWindow(window, CHAIN_ID, rescueContract);

  const onchainSafe = (await client.readContract({
    address: rescueContract, abi: MONRESCUE_ABI, functionName: 'SAFE_ADDRESS',
  })) as `0x${string}`;
  console.log(`\nrescue contract ${rescueContract}`);
  console.log(`destination locked to ${onchainSafe}`);

  const nonce = await client.getTransactionCount({ address: victim });
  const health = assessWindow(window, nonce);
  console.log(`victim nonce ${nonce} — ${health.message}`);
  if (health.exhausted) {
    throw new Error('authorization window exhausted; the user must sign a new one');
  }

  // --- 4. preflight -------------------------------------------------------
  const fees = await client.estimateFeesPerGas();
  const multiplier = BigInt(process.env.PRIORITY_FEE_MULTIPLIER ?? 20);
  const gas = BigInt(process.env.GAS_LIMIT ?? DEFAULT_RESCUE_GAS_LIMIT);
  const maxFeePerGas = (fees.maxFeePerGas ?? 100_000_000_000n) * multiplier;
  const budget = gasBudgetFromEnv();
  const plannedAttempts = Number(budget / (gas * maxFeePerGas)) || 1;

  const pf = await preflight({
    client, guardian: guardian.address, victim, gas, maxFeePerGas, plannedAttempts,
  });
  for (const w of pf.warnings) console.warn(`WARN: ${w}`);
  for (const e of pf.errors) console.error(`ERROR: ${e}`);
  if (!pf.ok) throw new Error('preflight failed');

  console.log(
    `\nbudget ${formatEther(budget)} MON affords ~${plannedAttempts} attempt(s) ` +
      `at ${gas} gas x ${formatEther(maxFeePerGas)} MON/gas`,
  );

  // --- 5. delegate now (eager) -------------------------------------------
  // In an emergency the attacker is already active, so stealth has no value left and being
  // armed does. Delegating now also means a delegated account cannot use the emptying
  // exception, which brakes the attacker's own plain transfers.
  const code = await client.getCode({ address: victim });
  const current = delegationTarget(code);
  if (current?.toLowerCase() === rescueContract.toLowerCase()) {
    console.log(`\nvictim already delegated to the rescue contract.`);
  } else {
    const auth = window.authorizations.find((a) => a.nonce === nonce);
    if (!auth) throw new Error(`no authorization for current nonce ${nonce}`);
    console.log(`\ndelegating victim -> ${rescueContract} (authorization at nonce ${nonce})...`);
    const hash = await wallet.sendTransaction({
      authorizationList: [auth],
      to: victim,
      value: 0n,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const after = await client.getCode({ address: victim });
    console.log(`  ${hash} -> ${receipt.status}, code now ${after}`);
    if (delegationTarget(after)?.toLowerCase() !== rescueContract.toLowerCase()) {
      throw new Error('delegation did not take effect — check executor/nonce handling');
    }
  }

  console.log(`\n=== ARMED ===`);
  console.log(`Run the hot path to watch and fire:`);
  console.log(
    `  CHAIN_ID=${CHAIN_ID} VICTIM_ADDRESS=${victim} ` +
      `VALIDATOR_ID=${positions[0]?.validatorId ?? '<id>'} WITHDRAW_ID=${positions[0]?.withdrawId ?? 0} ` +
      `pnpm --filter @monrescue/rescue-cli arm`,
  );
}

main().catch((e) => {
  console.error(`\nemergency intake failed: ${e.message}`);
  process.exit(1);
});
