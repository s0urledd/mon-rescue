/**
 * Deploy a MonRescue instance.
 *
 * One instance per protected user, each with its own immutable safe address. This is not
 * merely tidiness: a 7702 delegation is publicly readable via eth_getCode, so a single
 * well-known singleton would fingerprint every protected wallet and tell an attacker exactly
 * what to re-delegate away from. Per-user instances preserve the one advantage we have.
 *
 * Build the artifact first:  node contracts/build.mjs
 */
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainById, RPC_POOL, publicClientFor, STAKING_PRECOMPILE, RESERVE_PRECOMPILE } from '@monrescue/shared';
import { writeArtifact, requireEnv } from './lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

async function main() {
  const deployerKey = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const safeAddressRaw = requireEnv('SAFE_ADDRESS');
  const guardianRaw = requireEnv('GUARDIAN_ADDRESS');

  if (!isAddress(safeAddressRaw)) throw new Error(`SAFE_ADDRESS is not a valid address: ${safeAddressRaw}`);
  if (!isAddress(guardianRaw)) throw new Error(`GUARDIAN_ADDRESS is not a valid address: ${guardianRaw}`);

  const safeAddress = getAddress(safeAddressRaw);
  const guardian = getAddress(guardianRaw);

  // The constructor rejects these too, but failing here costs no gas and no confusion.
  for (const [label, addr] of [['staking', STAKING_PRECOMPILE], ['reserve', RESERVE_PRECOMPILE]] as const) {
    if (safeAddress.toLowerCase() === addr.toLowerCase()) {
      throw new Error(`SAFE_ADDRESS must not be the ${label} precompile — funds sent there are burned`);
    }
  }

  const artifactPath = join(HERE, '..', '..', 'contracts', 'out', 'MonRescue.json');
  let artifact: { abi: unknown[]; bytecode: `0x${string}`; solcVersion?: string };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    throw new Error(`missing ${artifactPath} — run \`node contracts/build.mjs\` (or \`forge build\`) first`);
  }

  const account = privateKeyToAccount(deployerKey);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const chain = chainById(CHAIN_ID);
  const publicClient = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer:      ${account.address} (${formatEther(balance)} MON)`);
  console.log(`safe address:  ${safeAddress}   <- funds can ONLY ever go here`);
  console.log(`guardian:      ${guardian}`);
  console.log(`solc:          ${artifact.solcVersion ?? 'unknown'}`);

  if (balance === 0n) throw new Error('deployer has no balance — fund it at https://faucet.monad.xyz');

  const hash = await wallet.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode,
    args: [safeAddress, guardian],
    chain,
    account,
  });
  console.log(`\ndeploy tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`deployment failed: status=${receipt.status}`);
  }
  const address = getAddress(receipt.contractAddress);
  console.log(`deployed at: ${address}`);

  // Verify the destination lock took, rather than trusting the constructor ran as intended.
  const onchainSafe = (await publicClient.readContract({
    address, abi: artifact.abi as never, functionName: 'SAFE_ADDRESS',
  })) as string;
  const locked = getAddress(onchainSafe) === safeAddress;
  console.log(`on-chain SAFE_ADDRESS: ${onchainSafe} ${locked ? '(locked correctly)' : '!! MISMATCH'}`);
  if (!locked) throw new Error('destination lock mismatch — do not use this deployment');

  console.log(`\nAdd to the repo-root .env:\n  RESCUE_CONTRACT=${address}`);
  console.log(`\n  echo "RESCUE_CONTRACT=${address}" >> .env`);

  // Catch an underfunded guardian now rather than at the unlock block. Monad caps an account's
  // gas across its inflight transactions at min(10 MON, lagged balance) over 3 blocks, so a thin
  // guardian is throttled at exactly the moment it needs to retry.
  const guardianBalance = await publicClient.getBalance({ address: guardian });
  console.log(`\nguardian balance: ${formatEther(guardianBalance)} MON`);
  if (guardianBalance < 10_000_000_000_000_000_000n) {
    console.warn(
      `  WARNING: below 10 MON. Monad caps per-account inflight gas at min(10 MON, lagged\n` +
        `  balance) over 3 blocks, so retries get throttled precisely when they matter. Top it up.`,
    );
  }

  await writeArtifact(`deploy-${CHAIN_ID}-${address.slice(0, 10)}`, {
    chainId: CHAIN_ID,
    address,
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    safeAddress,
    guardian,
    solcVersion: artifact.solcVersion,
    destinationLockVerified: locked,
  });
}

main().catch((e) => { console.error(`\ndeploy failed: ${e.message}`); process.exit(1); });
