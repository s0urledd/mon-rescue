/**
 * Re-delegate the victim EOA to the rescue contract, immediately. TEST HARNESS ONLY.
 *
 * A battle test can leave the victim delegated to the attacker's drainer — the attacker won the
 * previous run and left it there. arm reads the victim's current delegation to find the rescue
 * contract and to run its pre-arm simulation, so the victim must point at OUR contract before
 * arming; otherwise arm reads SAFE_ADDRESS() off the attacker's drainer and dies at startup.
 *
 * In production this state is established by the user's intake signature (a self-7702 delegation
 * to their rescue contract, submitted for them). This script reproduces that one step against the
 * throwaway victim key so a re-test can start from the clean, armed-and-delegated state.
 *
 *   REDELEGATE_TARGET   optional override; defaults to RESCUE_CONTRACT.
 */
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, STAKING_PRECOMPILE, RESERVE_PRECOMPILE,
} from '@monrescue/shared';
import { requireEnv } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

const delegatedTo = (code: string | undefined): string =>
  code && code.toLowerCase().startsWith('0xef0100') ? getAddress(('0x' + code.slice(8)) as `0x${string}`) : 'none';

async function main() {
  const account = privateKeyToAccount(requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`);
  const target = getAddress(process.env.REDELEGATE_TARGET ?? requireEnv('RESCUE_CONTRACT'));

  // Delegating an EOA to a Monad precompile bricks it permanently ("all calls to it will revert").
  // An authorization has no expiry, so guard before signing anything.
  for (const [name, addr] of [['staking', STAKING_PRECOMPILE], ['reserve', RESERVE_PRECOMPILE]] as const) {
    if (target.toLowerCase() === addr.toLowerCase()) {
      throw new Error(`refusing to delegate to the ${name} precompile — it would brick the account`);
    }
  }

  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const client = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  const before = await client.getCode({ address: account.address });
  console.log(`victim ${account.address}`);
  console.log(`  delegated now:      ${delegatedTo(before)}`);
  console.log(`  re-delegating to:   ${target} (rescue)`);
  if (delegatedTo(before) === target) {
    console.log(`\nalready delegated to the rescue contract — nothing to do.`);
    return;
  }

  // A 7702 self-delegation: the authorization re-delegates the EOA; the top-level call does nothing.
  // Self-sponsored, so the authorization nonce is txNonce + 1 (the tx consumes the current nonce
  // first). Pass it explicitly — viem's executor:'self' otherwise fetches at blockTag 'pending' and
  // diverges from the 'latest' tx nonce, which silently writes success while nothing applies (Q23).
  const txNonce = await client.getTransactionCount({ address: account.address });
  const authorization = await wallet.signAuthorization({
    account, contractAddress: target, executor: 'self', nonce: txNonce + 1,
  });
  const hash = await wallet.sendTransaction({
    to: account.address, data: '0x', nonce: txNonce, gas: 100_000n, authorizationList: [authorization], chain,
  } as never);
  console.log(`  broadcast ${hash} (tx nonce ${txNonce}, auth nonce ${txNonce + 1})`);
  const receipt = await client.waitForTransactionReceipt({ hash });

  const after = await client.getCode({ address: account.address });
  console.log(`  receipt ${receipt.status}; delegated to: ${delegatedTo(after)}`);
  if (delegatedTo(after) !== target) {
    throw new Error('re-delegation did not take — check the receipt and the victim nonce');
  }
  console.log(`\nvictim is delegated to the rescue contract. Safe to make-window + arm.`);
}

main().catch((e) => { console.error(`\nredelegate failed: ${e.message}`); process.exit(1); });
