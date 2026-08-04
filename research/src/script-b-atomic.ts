/**
 * Script B — THE GATE (Q1).
 *
 * Question: can a staking-precompile withdrawal and a native MON transfer execute
 * ATOMICALLY inside a single EIP-7702 transaction, as the delegated EOA?
 *
 * Why this is the whole product: Q5 established that undelegate/withdraw/claimRewards take
 * no recipient parameter and always pay `msg.sender`. So rescued funds necessarily land on
 * the compromised EOA. If the claim and the sweep cannot happen in one transaction, there is
 * a block in which liquid MON sits in a wallet the attacker controls — and the rescue is a
 * coin flip. If they can, the attacker has no gap to exploit and only transaction ordering
 * remains.
 *
 * Requires a FUNDED testnet key with an existing matured withdrawal request.
 * Run the whole sequence with: pnpm --filter @monrescue/research gate
 */
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import {
  createWalletClient, createPublicClient, http, encodeFunctionData, parseEther, formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, STAKING_PRECOMPILE, STAKING_ABI, getEpoch, getWithdrawalRequest,
  isClaimable, planSweep, publicClientFor,
} from '@monrescue/shared';
import { writeArtifact, requireEnv, MONRESCUE_ABI } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

async function main() {
  // This key is a RESEARCH key funded from the faucet. It is never a user's key —
  // MonRescue has no code path that accepts a protected user's key or seed.
  const pk = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const rescueContract = requireEnv('RESCUE_CONTRACT') as `0x${string}`;
  const safeAddress = requireEnv('SAFE_ADDRESS') as `0x${string}`;
  const validatorId = BigInt(requireEnv('VALIDATOR_ID'));
  const withdrawId = Number(process.env.WITHDRAW_ID ?? 0);

  const account = privateKeyToAccount(pk);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const publicClient = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  console.log(`victim EOA (research key): ${account.address}`);
  console.log(`rescue contract:           ${rescueContract}`);
  console.log(`safe address:              ${safeAddress}`);

  // --- preconditions -------------------------------------------------------
  const epoch = await getEpoch(publicClient);
  const req = await getWithdrawalRequest(publicClient, validatorId, account.address, withdrawId);
  console.log(`\nepoch ${epoch.epoch} (inDelay=${epoch.inEpochDelayPeriod})`);
  console.log(`withdrawal request: amount=${formatEther(req.withdrawalAmount)} MON withdrawEpoch=${req.withdrawEpoch}`);

  if (req.withdrawalAmount === 0n) {
    throw new Error('no pending withdrawal request — run script-b-setup (undelegate) first and wait one epoch');
  }
  if (!isClaimable(epoch, req.withdrawEpoch)) {
    throw new Error(`not claimable yet: current epoch ${epoch.epoch} < withdrawEpoch ${req.withdrawEpoch}`);
  }

  const startBalance = await publicClient.getBalance({ address: account.address });
  const plan = planSweep(startBalance, req.withdrawalAmount);
  console.log(`\nreserve plan: start=${formatEther(startBalance)} inflow=${formatEther(req.withdrawalAmount)}`);
  console.log(`  floor=${formatEther(plan.floor)} sweepable=${formatEther(plan.sweepable)} stranded=${formatEther(plan.stranded)}`);

  const safeBefore = await publicClient.getBalance({ address: safeAddress });

  // --- the actual test -----------------------------------------------------
  // Sign the 7702 authorization delegating this EOA to the rescue contract, then in the SAME
  // transaction call rescue() on ourselves. The delegated code runs in the EOA's context, so
  // the precompile sees msg.sender == this EOA and pays it, and the sweep forwards to the
  // safe address before the transaction ends.
  console.log('\nsigning EIP-7702 authorization...');
  const authorization = await wallet.signAuthorization({
    account,
    contractAddress: rescueContract,
    executor: 'self',
  });

  const data = encodeFunctionData({
    abi: MONRESCUE_ABI,
    functionName: 'rescue',
    args: [[validatorId], [withdrawId], true],
  });

  console.log('submitting type-0x04 transaction (authorization + rescue in one tx)...');
  const hash = await wallet.sendTransaction({
    authorizationList: [authorization],
    to: account.address, // call into ourselves; the delegated code executes
    data,
  });
  console.log(`tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const safeAfter = await publicClient.getBalance({ address: safeAddress });
  const delivered = safeAfter - safeBefore;

  const verdict = {
    question: 'Q1 — atomic staking withdraw + native transfer in one EIP-7702 batch',
    chainId: CHAIN_ID,
    txHash: hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    txType: receipt.type,
    gasUsed: receipt.gasUsed.toString(),
    epoch: epoch.epoch.toString(),
    withdrawalAmount: req.withdrawalAmount.toString(),
    eoaStartBalance: startBalance.toString(),
    safeAddressDelta: delivered.toString(),
    reservePlan: {
      floor: plan.floor.toString(),
      sweepable: plan.sweepable.toString(),
      stranded: plan.stranded.toString(),
    },
    atomic: receipt.status === 'success' && delivered > 0n,
  };

  console.log(`\nreceipt status: ${receipt.status}, block ${receipt.blockNumber}`);
  console.log(`safe address received: ${formatEther(delivered)} MON`);
  console.log(`\n>>> Q1 VERDICT: ${verdict.atomic ? 'YES — atomic claim+sweep lands in ONE transaction' : 'NO — see artifact'}`);

  await writeArtifact('q1-atomic-batch', verdict);
}

main().catch((e) => { console.error(`\nScript B failed: ${e.message}`); process.exit(1); });
