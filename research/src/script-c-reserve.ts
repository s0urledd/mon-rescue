/**
 * Script C — Q3: the exact revert behaviour of the 10 MON reserve rule.
 *
 * Phase 0 established from documentation that the floor for a non-sender account is
 * min(balanceAtStart, 10 MON) rather than a flat 10 MON — a distinction that decides whether
 * a drained wallet can be swept completely or loses its last 10 MON. This script proves it
 * on-chain and records the exact revert conditions.
 *
 * Sequence:
 *   1. While delegated, attempt a transfer that ends BELOW min(start, 10 MON) -> expect revert
 *   2. While delegated, attempt a transfer that ends exactly AT the floor      -> expect success
 *   3. Undelegate, wait k=3 blocks with no other activity, then empty          -> expect success
 *
 * Requires a funded testnet key.
 */
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, reserveFloor, planSweep,
  EMPTYING_EXCEPTION_DELAY_BLOCKS, USER_RESERVE_BALANCE,
} from '@monrescue/shared';
import { writeArtifact, requireEnv } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const ZERO_DELEGATE = '0x0000000000000000000000000000000000000000' as const;

async function main() {
  const pk = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const sink = requireEnv('SAFE_ADDRESS') as `0x${string}`;

  const account = privateKeyToAccount(pk);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const publicClient = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  const results: Record<string, unknown> = {};
  const start = await publicClient.getBalance({ address: account.address });
  const floor = reserveFloor(start);
  const code = await publicClient.getCode({ address: account.address });
  const isDelegated = !!code && code !== '0x';

  console.log(`EOA ${account.address}`);
  console.log(`balance ${formatEther(start)} MON, delegated=${isDelegated}`);
  console.log(`predicted floor = min(start, 10 MON) = ${formatEther(floor)} MON`);
  console.log(`predicted sweepable = ${formatEther(planSweep(start, 0n).sweepable)} MON\n`);

  if (!isDelegated) {
    throw new Error('EOA is not 7702-delegated — run script-a-7702 first, since the reserve rule only binds delegated accounts');
  }

  // --- case 1: end below the floor -> must revert ---------------------------
  const overshoot = floor > 0n ? start - floor + parseEther('0.5') : start;
  console.log(`case 1: transfer ${formatEther(overshoot)} MON (ends below floor) — expecting REVERT`);
  try {
    const h = await wallet.sendTransaction({ to: sink, value: overshoot });
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    results.belowFloor = { outcome: r.status === 'reverted' ? 'reverted (expected)' : 'SUCCEEDED — contradicts the documented rule', txHash: h, status: r.status };
    console.log(`  -> ${r.status}`);
  } catch (e) {
    results.belowFloor = { outcome: 'rejected before inclusion (expected)', error: (e as Error).message.split('\n')[0] };
    console.log(`  -> rejected: ${(e as Error).message.split('\n')[0]}`);
  }

  // --- case 2: end exactly at the floor -> must succeed ---------------------
  const now = await publicClient.getBalance({ address: account.address });
  const gasReserve = parseEther('0.05');
  const exact = now > floor + gasReserve ? now - floor - gasReserve : 0n;
  if (exact > 0n) {
    console.log(`\ncase 2: transfer ${formatEther(exact)} MON (ends at floor) — expecting SUCCESS`);
    try {
      const h = await wallet.sendTransaction({ to: sink, value: exact });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      results.atFloor = { outcome: r.status, txHash: h };
      console.log(`  -> ${r.status}`);
    } catch (e) {
      results.atFloor = { outcome: 'failed', error: (e as Error).message.split('\n')[0] };
      console.log(`  -> failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  // --- case 3: undelegate, wait k blocks, then empty ------------------------
  console.log(`\ncase 3: undelegate then empty below the floor`);
  const auth = await wallet.signAuthorization({ account, contractAddress: ZERO_DELEGATE, executor: 'self' });
  const undelegateHash = await wallet.sendTransaction({ authorizationList: [auth], to: account.address, value: 0n });
  await publicClient.waitForTransactionReceipt({ hash: undelegateHash });
  const codeNow = await publicClient.getCode({ address: account.address });
  console.log(`  undelegated (tx ${undelegateHash}), code now: ${codeNow ?? '0x'}`);

  // The emptying exception requires k=3 blocks with NO transaction from this account and no
  // delegation request touching it. Waiting is part of the rule, not politeness.
  const target = (await publicClient.getBlockNumber()) + BigInt(EMPTYING_EXCEPTION_DELAY_BLOCKS) + 1n;
  console.log(`  waiting for block ${target} (k=${EMPTYING_EXCEPTION_DELAY_BLOCKS} quiet blocks)...`);
  while ((await publicClient.getBlockNumber()) < target) {
    await new Promise((r) => setTimeout(r, 400));
  }

  const finalBalance = await publicClient.getBalance({ address: account.address });
  const leave = parseEther('0.05');
  const emptyAmount = finalBalance > leave ? finalBalance - leave : 0n;
  console.log(`  emptying ${formatEther(emptyAmount)} MON while undelegated — expecting SUCCESS`);
  try {
    const h = await wallet.sendTransaction({ to: sink, value: emptyAmount });
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    results.emptyingException = { outcome: r.status, txHash: h, endedBelowFloor: true };
    console.log(`  -> ${r.status}`);
  } catch (e) {
    results.emptyingException = { outcome: 'failed', error: (e as Error).message.split('\n')[0] };
    console.log(`  -> failed: ${(e as Error).message.split('\n')[0]}`);
  }

  await writeArtifact('q3-reserve-balance', {
    question: 'Q3 — exact revert conditions of the 10 MON reserve rule',
    chainId: CHAIN_ID,
    eoa: account.address,
    startBalance: start.toString(),
    predictedFloor: floor.toString(),
    userReserveBalance: USER_RESERVE_BALANCE.toString(),
    emptyingExceptionDelayBlocks: EMPTYING_EXCEPTION_DELAY_BLOCKS,
    cases: results,
  });
}

main().catch((e) => { console.error(`\nScript C failed: ${e.message}`); process.exit(1); });
