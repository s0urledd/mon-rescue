/**
 * Deploy the AdversaryDrainer — TEST HARNESS ONLY.
 *
 * The opponent for MODE=atomic: what a competent attacker delegates a compromised EOA to, so the
 * battle test measures our defence against the attack that is actually common (a re-delegating
 * sweeper, ~97% of mainnet 7702 delegations) rather than the two-transaction one we find easy to
 * beat.
 *
 * Its SINK is immutable and set here to ATTACKER_SINK, mirroring SAFE_ADDRESS in MonRescue. A
 * deployed instance can only ever move funds to that address, so deploying it grants nobody
 * anything they did not already have by holding the victim key.
 *
 *   node contracts/build.mjs && pnpm --filter @monrescue/research deploy:drainer
 */
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainById, RPC_POOL, publicClientFor } from '@monrescue/shared';
import { writeArtifact, requireEnv } from './lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

async function main() {
  const deployerKey = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const sinkRaw = requireEnv('ATTACKER_SINK');
  if (!isAddress(sinkRaw)) throw new Error(`ATTACKER_SINK is not a valid address: ${sinkRaw}`);
  const sink = getAddress(sinkRaw);

  const artifactPath = join(HERE, '..', '..', 'contracts', 'out', 'AdversaryDrainer.json');
  let artifact: { abi: unknown[]; bytecode: `0x${string}`; solcVersion?: string };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    throw new Error(`missing ${artifactPath} — run \`node contracts/build.mjs\` first`);
  }

  const account = privateKeyToAccount(deployerKey);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const chain = chainById(CHAIN_ID);
  const publicClient = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  console.log(`deployer: ${account.address}`);
  console.log(`sink:     ${sink}   <- the drainer can only ever send here`);

  const hash = await wallet.deployContract({
    abi: artifact.abi as never, bytecode: artifact.bytecode, args: [sink], chain, account,
  });
  console.log(`\ndeploy tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`deployment failed: status=${receipt.status}`);
  }
  const address = getAddress(receipt.contractAddress);
  const onchainSink = getAddress((await publicClient.readContract({
    address, abi: artifact.abi as never, functionName: 'SINK',
  })) as string);
  console.log(`deployed at: ${address}`);
  const sinkOk = onchainSink === sink;
  console.log(`on-chain SINK: ${onchainSink} ${sinkOk ? '(ok)' : '!! MISMATCH'}`);
  // Throw rather than fall through to a success footer with exit code 0, as deploy.ts does for
  // its destination lock. A drainer whose SINK does not match what was asked for is not a usable
  // opponent — a mismatch means an encoding regression or a tampered artifact, and a subsequent
  // atomic battle test would trust a contract that sends somewhere unexpected.
  if (!sinkOk) throw new Error('on-chain SINK does not match ATTACKER_SINK — do not use this drainer');

  console.log(`\nAdd to .env for MODE=atomic:\n  echo "ADVERSARY_DRAINER=${address}" >> .env`);
  await writeArtifact(`deploy-drainer-${CHAIN_ID}`, { address, sink, deployTx: hash });
}

main().catch((e) => { console.error(`\ndeploy-drainer failed: ${e.message}`); process.exit(1); });
