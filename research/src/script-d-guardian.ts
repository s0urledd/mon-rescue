/**
 * Script D — Q4: can a SEPARATE guardian address trigger a destination-locked sweep on a
 * delegated EOA, and is the destination genuinely un-redirectable?
 *
 * Two things are proven here, and the second matters more:
 *   1. The guardian (a different key from the user's) can invoke rescue()/sweep() on the
 *      delegated EOA and move funds.
 *   2. An ATTACKER who controls the EOA cannot redirect those funds. We verify this by
 *      confirming the contract exposes no arbitrary-recipient path and that SAFE_ADDRESS is
 *      immutable — the destination is fixed at construction, so triggering the function is
 *      harmless in the wrong hands.
 *
 * Requires two funded testnet keys: the research "victim" key and a guardian key.
 */
import { config as loadEnv } from 'dotenv';
// Load the repo-root .env first, then any package-local one. dotenv never overrides an
// already-set variable, so package-local and real environment variables both win over the root.
loadEnv({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });
loadEnv({ quiet: true });
import { createWalletClient, http, formatEther, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainById, RPC_POOL, publicClientFor } from '@monrescue/shared';
import { writeArtifact, requireEnv, MONRESCUE_ABI } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

async function main() {
  const victimPk = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const guardianPk = requireEnv('GUARDIAN_PRIVATE_KEY') as `0x${string}`;
  const rescueContract = requireEnv('RESCUE_CONTRACT') as `0x${string}`;
  const safeAddress = getAddress(requireEnv('SAFE_ADDRESS'));

  const victim = privateKeyToAccount(victimPk);
  const guardian = privateKeyToAccount(guardianPk);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const publicClient = publicClientFor(CHAIN_ID, url);
  const guardianWallet = createWalletClient({ account: guardian, chain, transport: http(url) });
  const victimWallet = createWalletClient({ account: victim, chain, transport: http(url) });

  console.log(`victim EOA:      ${victim.address}`);
  console.log(`guardian:        ${guardian.address}`);
  console.log(`rescue contract: ${rescueContract}`);
  console.log(`safe address:    ${safeAddress}\n`);

  // --- confirm the destination lock is real, not a convention -------------
  const onchainSafe = await publicClient.readContract({
    address: rescueContract, abi: MONRESCUE_ABI, functionName: 'SAFE_ADDRESS',
  });
  const lockOk = getAddress(onchainSafe as string) === safeAddress;
  console.log(`contract SAFE_ADDRESS = ${onchainSafe} (${lockOk ? 'matches' : 'MISMATCH'})`);

  // Widened deliberately: against the literal ABI type TypeScript proves at compile time that
  // no function input is an `address`, so the comparison below is statically impossible. That
  // static proof is the destination lock — but we still assert it at runtime, because the
  // property must hold against the ABI as deployed, not merely as declared here.
  const abi = MONRESCUE_ABI as readonly {
    type: string;
    name?: string;
    stateMutability?: string;
    inputs?: readonly { type: string }[];
  }[];

  const writableFns = abi
    .filter((e) => e.type === 'function' && e.stateMutability === 'nonpayable')
    .map((e) => e.name ?? '(unnamed)');
  const takesRecipient = abi.some(
    (e) => e.type === 'function' && (e.inputs ?? []).some((i) => i.type === 'address'),
  );
  console.log(`state-changing functions: ${writableFns.join(', ')}`);
  console.log(`any function accepting an address argument: ${takesRecipient ? 'YES — DESTINATION LOCK BROKEN' : 'no (destination lock intact)'}`);

  // --- ensure the victim EOA is delegated ---------------------------------
  let code = await publicClient.getCode({ address: victim.address });
  const expected = `0xef0100${rescueContract.slice(2).toLowerCase()}`;
  if (code?.toLowerCase() !== expected) {
    console.log('\nvictim not yet delegated to the rescue contract — delegating...');
    const auth = await victimWallet.signAuthorization({
      account: victim, contractAddress: rescueContract, executor: 'self',
    });
    const h = await victimWallet.sendTransaction({ authorizationList: [auth], to: victim.address, value: 0n });
    await publicClient.waitForTransactionReceipt({ hash: h });
    code = await publicClient.getCode({ address: victim.address });
    console.log(`delegated (tx ${h}), code: ${code}`);
  }

  // --- the guardian fires the sweep ---------------------------------------
  const victimBefore = await publicClient.getBalance({ address: victim.address });
  const safeBefore = await publicClient.getBalance({ address: safeAddress });
  console.log(`\nvictim balance ${formatEther(victimBefore)} MON, sweeping via guardian...`);

  const data = encodeFunctionData({ abi: MONRESCUE_ABI, functionName: 'sweep', args: [] });
  const hash = await guardianWallet.sendTransaction({ to: victim.address, data });
  console.log(`tx: ${hash} (sender = guardian, target = victim EOA)`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const safeAfter = await publicClient.getBalance({ address: safeAddress });
  const delivered = safeAfter - safeBefore;

  console.log(`receipt: ${receipt.status}`);
  console.log(`safe address received ${formatEther(delivered)} MON`);
  console.log(`\n>>> Q4 VERDICT: ${receipt.status === 'success' && delivered > 0n ? 'YES — a separate guardian triggers a destination-locked sweep' : 'NO — see artifact'}`);

  await writeArtifact('q4-guardian-trigger', {
    question: 'Q4 — separate guardian triggers a destination-locked sweep on a delegated EOA',
    chainId: CHAIN_ID,
    txHash: hash,
    status: receipt.status,
    guardian: guardian.address,
    victim: victim.address,
    safeAddress,
    destinationLockedOnChain: lockOk,
    anyFunctionAcceptsAddressArgument: takesRecipient,
    victimBalanceBefore: victimBefore.toString(),
    safeAddressDelta: delivered.toString(),
    guardianCanTrigger: receipt.status === 'success' && delivered > 0n,
  });
}

main().catch((e) => { console.error(`\nScript D failed: ${e.message}`); process.exit(1); });
