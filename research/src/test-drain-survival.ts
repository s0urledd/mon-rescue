/**
 * Isolated measurement — does a REVERTED atomic drain leave the delegation applied? ~1 minute.
 * TEST HARNESS ONLY. No flip wait, no fresh position needed.
 *
 * The last thing gating the atomic prequeue battle test. In `MODE=atomic ADVERSARY_STRATEGY=prequeue`
 * the attacker sprays drain attempts across the flip window; the premature ones (withdrawal not
 * matured) self-delegate the EOA to the drainer and then revert in `drain()` (NothingToTake). The
 * question the spray's correctness depends on: when that top-level call reverts, is the EIP-7702
 * authorization's delegation change ALSO rolled back, or does the delegation persist on the drainer?
 *
 * The EIP-7702 spec applies the authorization (nonce increment + delegation designator) during
 * transaction processing, before execution, and does not roll it back on a top-level revert — but
 * that is a claim to verify on Monad, not assume. This measures it directly:
 *
 *   1. Record the victim's delegation (expected: our rescue contract).
 *   2. Broadcast ONE atomic self-delegate-to-drainer + drain() on an unmatured/empty slot, so
 *      drain() reverts.
 *   3. Read the delegation after. Drainer => the authorization survived the revert. Unchanged =>
 *      it rolled back.
 *
 * Either answer is fine; the atomic spray just has to account for the right one. Undoing it after:
 * the guardian re-asserts our delegation, same as a rescue would.
 */
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, getAddress, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainById, RPC_POOL, publicClientFor } from '@monrescue/shared';
import { requireEnv, writeArtifact } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const DRAIN_ABI = [{
  type: 'function', name: 'drain', stateMutability: 'nonpayable',
  inputs: [{ name: 'validatorIds', type: 'uint64[]' }, { name: 'withdrawIds', type: 'uint8[]' }], outputs: [],
}] as const;

async function main() {
  const victim = privateKeyToAccount(requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`);
  const drainer = getAddress(requireEnv('ADVERSARY_DRAINER'));
  const validatorId = BigInt(requireEnv('VALIDATOR_ID'));
  const withdrawId = Number(process.env.WITHDRAW_ID ?? 0);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const client = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account: victim, chain, transport: http(url) });

  const codeBefore = await client.getCode({ address: victim.address });
  console.log(`victim ${victim.address}: ${formatEther(await client.getBalance({ address: victim.address }))} MON`);
  console.log(`delegated before: ${codeBefore && codeBefore.length === 48 ? '0x' + codeBefore.slice(8) : 'none'}`);

  // One atomic self-delegate-to-drainer + drain(). On an empty/unmatured slot drain() reverts
  // with NothingToTake, which is exactly the premature-attempt case.
  const drainData = encodeFunctionData({ abi: DRAIN_ABI, functionName: 'drain', args: [[validatorId], [withdrawId]] });
  const txNonce = await client.getTransactionCount({ address: victim.address });
  const authorization = await wallet.signAuthorization({
    account: victim, contractAddress: drainer, executor: 'self', nonce: txNonce + 1,
  });
  console.log(`\nbroadcasting atomic drain (expected to revert on an empty slot)...`);
  const hash = await wallet.sendTransaction({
    to: victim.address, data: drainData, nonce: txNonce, gas: 400_000n, authorizationList: [authorization], chain,
  } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  console.log(`  drain tx ${hash} -> ${r.status} in block ${r.blockNumber}`);

  const codeAfter = await client.getCode({ address: victim.address });
  const delegatedTo = codeAfter && codeAfter.length === 48 ? '0x' + codeAfter.slice(8) : 'none';
  const survived = delegatedTo.toLowerCase() === drainer.toLowerCase();
  const nonceAfter = await client.getTransactionCount({ address: victim.address });

  console.log(`\n=== RESULT ===`);
  console.log(`drain reverted:      ${r.status === 'reverted' ? 'yes (as expected)' : 'NO — it succeeded?!'}`);
  console.log(`delegated after:     ${delegatedTo}`);
  console.log(`victim nonce:        ${txNonce} -> ${nonceAfter} (${nonceAfter - txNonce} consumed)`);
  console.log(`\nDELEGATION ${survived
    ? 'SURVIVED the revert — the authorization applies before the call and is NOT rolled back. The '
      + 'atomic spray must account for the drainer delegation persisting across premature attempts.'
    : 'ROLLED BACK with the revert — the delegation did not persist. Each atomic attempt re-delegates fresh.'}`);
  // Cleanup: leave the victim delegated back to the rescue contract, so this measurement does not
  // strand the account on the drainer for the next test. The victim self-signs (its own key).
  let cleaned = false;
  if (survived) {
    const rescueContract = getAddress(requireEnv('RESCUE_CONTRACT'));
    console.log(`\nrestoring delegation to the rescue contract ${rescueContract}...`);
    const n = await client.getTransactionCount({ address: victim.address });
    const backAuth = await wallet.signAuthorization({
      account: victim, contractAddress: rescueContract, executor: 'self', nonce: n + 1,
    });
    const backHash = await wallet.sendTransaction({
      to: victim.address, data: '0x', nonce: n, gas: 100_000n, authorizationList: [backAuth], chain,
    } as never);
    await client.waitForTransactionReceipt({ hash: backHash });
    const finalCode = await client.getCode({ address: victim.address });
    cleaned = finalCode?.toLowerCase() === `0xef0100${rescueContract.slice(2).toLowerCase()}`;
    console.log(`  restored: ${cleaned ? 'yes, delegated to rescue contract again' : 'NO — re-assert manually before arming'}`);
  }

  await writeArtifact('test-drain-survival', {
    drainTx: hash, drainStatus: r.status, delegatedBefore: codeBefore, delegatedAfter: codeAfter,
    delegationSurvivedRevert: survived, nonceConsumed: Number(nonceAfter - txNonce), cleaned,
  });
  process.exit(0);
}

main().catch((e) => { console.error(`\ntest-drain-survival failed: ${e.message}`); process.exit(1); });
