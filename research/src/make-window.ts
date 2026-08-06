/**
 * Build an authorization window — TEST HARNESS ONLY.
 *
 * In production a user signs these in their own wallet through the approval page and we never
 * see a key. This script exists so the battle test can be run end to end without a browser, and
 * it operates on a throwaway testnet research key.
 *
 * It must never become the production path. If a version of this ever reads a protected user's
 * key, the security model is gone.
 */
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync } from 'node:fs';
import { chainById, RPC_POOL, publicClientFor, STAKING_PRECOMPILE, RESERVE_PRECOMPILE } from '@monrescue/shared';
import { requireEnv } from './lib.js';
import { isAbsolute, resolve } from 'node:path';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const WINDOW_SIZE = Number(process.env.AUTH_WINDOW_SIZE ?? 64);
const OUT = process.env.AUTH_WINDOW_FILE ?? './window.json';

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

async function main() {
  const pk = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const rescueContract = getAddress(requireEnv('RESCUE_CONTRACT'));

  // Delegating an EOA to a Monad precompile bricks it permanently: "all calls to it will
  // revert". Guard before signing anything, because an authorization has no expiry.
  for (const [name, addr] of [['staking', STAKING_PRECOMPILE], ['reserve', RESERVE_PRECOMPILE]] as const) {
    if (rescueContract.toLowerCase() === addr.toLowerCase()) {
      throw new Error(`refusing to sign a delegation to the ${name} precompile — it would brick the account`);
    }
  }

  const account = privateKeyToAccount(pk);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const client = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  const startNonce = await client.getTransactionCount({ address: account.address });
  console.log(`signing ${WINDOW_SIZE} authorizations for ${account.address}`);
  console.log(`  delegate target: ${rescueContract}`);
  console.log(`  nonces ${startNonce}..${startNonce + WINDOW_SIZE - 1}`);

  const authorizations = [];
  for (let i = 0; i < WINDOW_SIZE; i++) {
    // No `executor: 'self'` and an explicit nonce: these are relayer-submitted, so the
    // authority's nonce is NOT pre-incremented by a sender bump. Getting this wrong makes the
    // authorization silently skip at execution while still burning ~25k gas.
    authorizations.push(
      await wallet.signAuthorization({
        account,
        contractAddress: rescueContract,
        chainId: CHAIN_ID,
        nonce: startNonce + i,
      }),
    );
  }

  const window = {
    authority: account.address,
    contractAddress: rescueContract,
    chainId: CHAIN_ID,
    startNonce,
    authorizations,
    signedAt: Date.now(),
  };

  writeFileSync(
    resolveFromRepoRoot(OUT),
    JSON.stringify(window, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n',
  );
  console.log(`\nwrote ${resolveFromRepoRoot(OUT)}`);
  console.log(`This file is a live capability over the account's delegation. It can only ever`);
  console.log(`point at the destination-locked rescue contract, so a leak is nonce griefing,`);
  console.log(`not fund loss — but do not commit it.`);
}

main().catch((e) => { console.error(`\nmake-window failed: ${e.message}`); process.exit(1); });
