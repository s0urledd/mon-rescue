/**
 * Isolated anti-revoke test — no flip wait, ~1 minute. TEST HARNESS ONLY.
 *
 * Three battle tests never exercised window.json because the attacker never re-delegated, and the
 * one that was supposed to (relock at epoch 1053) crashed on an unguarded poll loop before it
 * fired. The anti-revoke mechanism does not depend on a flip, though, so it can be tested directly
 * and immediately:
 *
 *   1. The attacker re-delegates the victim EOA to their drainer (victim key).
 *   2. The guardian broadcasts a `sweep()` call to the victim CARRYING our authorization list
 *      (re-delegating the victim back to the rescue contract). The authorization is processed
 *      before the top-level call, so if it works, the victim is ours again and `sweep()` runs our
 *      code; if it does not, the call lands on the attacker's drainer, which has no `sweep()`, and
 *      reverts.
 *   3. Read the result: did the delegation flip back to us, and did the sweep move funds?
 *
 * This needs the victim to hold a little loose balance above the 10 MON floor so a successful
 * sweep has something to move — otherwise sweep reverts with NothingToSweep even when the
 * authorization worked, which would be ambiguous. Fund the victim to ~15 MON first.
 *
 * Positive result = the destination-locked contract's code ran AFTER our authorization re-asserted
 * our delegation over the attacker's re-delegation. That is the anti-revoke property, demonstrated.
 */
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, getAddress, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { chainById, RPC_POOL, publicClientFor, planSweep } from '@monrescue/shared';
import { requireEnv, writeArtifact } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const SWEEP_ABI = [{ type: 'function', name: 'sweep', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const;

function resolveFromRepoRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(new URL('../../', import.meta.url).pathname, p);
}

async function main() {
  const victim = privateKeyToAccount(requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`);
  const guardian = privateKeyToAccount(requireEnv('GUARDIAN_PRIVATE_KEY') as `0x${string}`);
  const rescueContract = getAddress(requireEnv('RESCUE_CONTRACT'));
  const drainer = getAddress(requireEnv('ADVERSARY_DRAINER'));
  const safe = getAddress(requireEnv('SAFE_ADDRESS'));
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const client = publicClientFor(CHAIN_ID, url);
  const victimWallet = createWalletClient({ account: victim, chain, transport: http(url) });
  const guardianWallet = createWalletClient({ account: guardian, chain, transport: http(url) });

  const startBal = await client.getBalance({ address: victim.address });
  const sweepable = planSweep(startBal, 0n).sweepable;
  console.log(`victim ${victim.address}: ${formatEther(startBal)} MON, ${formatEther(sweepable)} sweepable`);
  if (sweepable === 0n) {
    throw new Error(`victim has nothing above the 10 MON floor to sweep — fund it to ~15 MON first, ` +
      `so a successful sweep has something to move and the result is unambiguous.`);
  }
  const safeBaseline = await client.getBalance({ address: safe });

  // --- 1. attacker re-delegates victim -> drainer ---------------------------
  console.log(`\n[attacker] re-delegating victim to the drainer ${drainer}...`);
  const relockNonce = await client.getTransactionCount({ address: victim.address });
  const relockAuth = await victimWallet.signAuthorization({
    account: victim, contractAddress: drainer, executor: 'self', nonce: relockNonce + 1,
  });
  const relockHash = await victimWallet.sendTransaction({
    to: victim.address, data: '0x', nonce: relockNonce, gas: 100_000n, authorizationList: [relockAuth], chain,
  } as never);
  await client.waitForTransactionReceipt({ hash: relockHash });
  const codeAfterRelock = await client.getCode({ address: victim.address });
  const delegatedToDrainer = codeAfterRelock?.toLowerCase() === `0xef0100${drainer.slice(2).toLowerCase()}`;
  console.log(`  victim now delegated to: ${codeAfterRelock && codeAfterRelock.length === 48 ? '0x' + codeAfterRelock.slice(8) : 'none'}` +
    `  ${delegatedToDrainer ? '(drainer — locked out)' : '(NOT the drainer?!)'}`);
  if (!delegatedToDrainer) throw new Error('re-delegation to the drainer did not take — cannot test anti-revoke');

  // --- 2. guardian sweeps, carrying our authorization to re-assert -----------
  const windowPath = resolveFromRepoRoot(process.env.AUTH_WINDOW_FILE ?? './window.json');
  const window = JSON.parse(readFileSync(windowPath, 'utf8')) as { authorizations: { nonce: number }[] };
  const victimNonce = await client.getTransactionCount({ address: victim.address });
  const auth = window.authorizations.find((a) => a.nonce === victimNonce);
  if (!auth) throw new Error(`no authorization in window.json for victim nonce ${victimNonce} — window exhausted or stale`);
  console.log(`\n[guardian] sweeping with authorization re-asserting delegation at victim nonce ${victimNonce}...`);

  const sweepData = encodeFunctionData({ abi: SWEEP_ABI, functionName: 'sweep', args: [] });
  const guardianNonce = await client.getTransactionCount({ address: guardian.address });
  const sweepHash = await guardianWallet.sendTransaction({
    to: victim.address, data: sweepData, nonce: guardianNonce, gas: 150_000n,
    authorizationList: [auth], chain,
  } as never);
  const sweepReceipt = await client.waitForTransactionReceipt({ hash: sweepHash });

  // --- 3. read the result ---------------------------------------------------
  const [codeAfter, safeAfter, victimAfter] = await Promise.all([
    client.getCode({ address: victim.address }),
    client.getBalance({ address: safe }),
    client.getBalance({ address: victim.address }),
  ]);
  const backToUs = codeAfter?.toLowerCase() === `0xef0100${rescueContract.slice(2).toLowerCase()}`;
  const swept = safeAfter - safeBaseline;

  console.log(`\n=== RESULT ===`);
  console.log(`sweep tx ${sweepHash} -> ${sweepReceipt.status} in block ${sweepReceipt.blockNumber}`);
  console.log(`victim delegated after: ${codeAfter && codeAfter.length === 48 ? '0x' + codeAfter.slice(8) : 'none'}` +
    `  ${backToUs ? '(RE-ASSERTED to rescue contract)' : '(still drainer / other)'}`);
  console.log(`safe received: ${formatEther(swept)} MON`);
  console.log(`victim now: ${formatEther(victimAfter)} MON`);

  const pass = sweepReceipt.status === 'success' && backToUs && swept > 0n;
  console.log(`\n${pass
    ? 'PASS — our authorization re-asserted our delegation over the attacker\'s re-delegation, and '
      + 'the destination-locked sweep ran. Anti-revoke demonstrated.'
    : 'FAIL — the re-assertion did not hold; the sweep did not run through our contract. Investigate.'}`);

  await writeArtifact('test-antirevoke', {
    relockHash, delegatedToDrainer, sweepHash, sweepStatus: sweepReceipt.status,
    backToUs, sweptWei: swept.toString(), pass,
  });
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(`\ntest-antirevoke failed: ${e.message}`); process.exit(1); });
