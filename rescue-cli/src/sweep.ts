/**
 * Sweep whatever native MON is sitting on the victim EOA to the safe address.
 *
 * The case this exists for: the attacker's `withdraw()` landed before ours. The precompile pays
 * `msg.sender`, which is the victim EOA, so their claim deposits the funds into an account that
 * is *still delegated to our destination-locked contract*. They then need a second transaction
 * to move it — and that second transaction is the gap this closes.
 *
 * It is also the tool for a state that `rescue()` cannot reach: an empty withdrawal slot with a
 * live balance. `rescue()` calls `withdraw()` first, and the staking precompile consumes all
 * gas when that call fails, so a rescue aimed at a slot somebody already claimed can run out of
 * gas before it ever reaches the sweep. `sweep()` touches no precompile and costs almost
 * nothing.
 *
 *   VICTIM_ADDRESS=0x... pnpm --filter @monrescue/rescue-cli sweep
 *
 * Destination is not a parameter here and cannot be: it is immutable in the victim's own
 * contract. This command can only ever move the user's money to the user's own safe address.
 */
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, encodeFunctionData, getAddress, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainById, RPC_POOL, publicClientFor, planSweep } from '@monrescue/shared';
import { MONRESCUE_ABI } from './abi.js';
import { delegationTarget } from './guard.js';
import { broadcastEverywhere } from './broadcast.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 143);

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing ${key}`);
  return v;
}

async function main() {
  const guardian = privateKeyToAccount(requireEnv('GUARDIAN_PRIVATE_KEY') as `0x${string}`);
  const victim = getAddress(requireEnv('VICTIM_ADDRESS'));
  const chain = chainById(CHAIN_ID);
  const urls = RPC_POOL[CHAIN_ID] ?? [];
  const client = publicClientFor(CHAIN_ID, process.env.MONAD_HTTP_URL ?? urls[0]!);
  const wallet = createWalletClient({
    account: guardian, chain, transport: http(process.env.MONAD_HTTP_URL ?? urls[0]!),
  });

  const [balance, code] = await Promise.all([
    client.getBalance({ address: victim }),
    client.getCode({ address: victim }),
  ]);
  const target = delegationTarget(code);

  console.log(`guardian ${guardian.address}`);
  console.log(`victim   ${victim}`);
  console.log(`balance  ${formatEther(balance)} MON`);
  console.log(`delegate ${target ?? 'NONE'}`);

  if (!target) {
    throw new Error(
      'victim is not 7702-delegated — there is no contract on the account to call sweep() on. ' +
        'Re-assert the delegation first.',
    );
  }

  // startBalance == current balance here: sweep() is called with no inflow, so the floor is
  // min(balance, 10 MON) and everything above it is movable.
  const plan = planSweep(balance, 0n);
  console.log(`floor    ${formatEther(plan.floor)} MON`);
  console.log(`sweepable ${formatEther(plan.sweepable)} MON`);
  if (plan.sweepable === 0n) {
    throw new Error('nothing above the reserve floor to sweep');
  }

  // This is a race against the attacker's second transaction, so bid like it. Being outbid here
  // costs the position; overpaying costs gas.
  const tipGwei = process.env.SWEEP_TIP_GWEI ?? '2000';
  const maxPriorityFeePerGas = parseGwei(tipGwei);
  const maxFeePerGas = parseGwei('300') + maxPriorityFeePerGas;

  const data = encodeFunctionData({ abi: MONRESCUE_ABI, functionName: 'sweep', args: [] });
  const nonce = await client.getTransactionCount({ address: guardian.address });
  const gas = BigInt(process.env.SWEEP_GAS_LIMIT ?? 120_000);

  console.log(`\nsweeping at ${tipGwei} gwei tip, gas ${gas}, nonce ${nonce}...`);
  const raw = await wallet.signTransaction({
    to: victim, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, chain,
  } as never);
  const r = await broadcastEverywhere(CHAIN_ID, raw, urls);
  if (!r.hash) {
    for (const a of r.attempts) console.error(`  ${a.url}: ${a.error ?? a.hash}`);
    throw new Error('rejected by every endpoint');
  }
  console.log(`tx ${r.hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash: r.hash });
  console.log(`receipt ${receipt.status} in block ${receipt.blockNumber}`);

  const after = await client.getBalance({ address: victim });
  console.log(`victim balance ${formatEther(balance)} -> ${formatEther(after)} MON`);
  process.exit(receipt.status === 'success' ? 0 : 1);
}

main().catch((e) => { console.error(`\nsweep failed: ${e.message}`); process.exit(1); });
