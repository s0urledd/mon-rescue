/**
 * Anti-revoke attacker — TEST HARNESS ONLY.
 *
 * The one thing three battle tests never exercised: what happens when the attacker re-delegates
 * the victim EOA away from our rescue contract to lock us out. The naive attacker leaves our
 * delegation intact, so `window.json`'s whole reason to exist has never been under load.
 *
 * This plays exactly that move and nothing else. It re-delegates the victim — to the attacker's
 * drainer, or to the zero address to clear the delegation entirely — one or more times through
 * the flip window. It does NOT try to claim or move funds; isolating the re-delegation is the
 * point, so a win or loss is attributable to the anti-revoke path alone.
 *
 * Our defence, under test: every pre-signed rescue attempt carries authorizations (marching
 * nonces) that re-assert our delegation in the authorization phase, BEFORE the top-level rescue
 * call. So an attacker re-delegation is meant to be something our own transaction undoes inside
 * itself. If the marching range covers the victim's nonce after the attacker has bumped it, we
 * still rescue. If the attacker can bump the nonce past our window, they lock us out — and
 * `assessWindow` is supposed to warn before that is possible.
 *
 * The attacker key is the victim key (they hold the seed). Throwaway testnet account only.
 *
 *   MODE(single | grief) via RELOCK_MODE; target via RELOCK_TARGET(drainer | zero).
 *   RELOCK_EVERY_BLOCKS controls grief cadence.
 */
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, getAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, getEpoch, getWithdrawalRequest,
  maturityEpoch, sprayStartBlockFor, latestStartBlockFor,
} from '@monrescue/shared';
import { requireEnv } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const RELOCK_MODE = (process.env.RELOCK_MODE ?? 'single').toLowerCase(); // single | grief
const RELOCK_EVERY = Number(process.env.RELOCK_EVERY_BLOCKS ?? 4);
const POLL_MS = Number(process.env.RELOCK_POLL_MS ?? 50);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const account = privateKeyToAccount(requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`);
  const validatorId = BigInt(requireEnv('VALIDATOR_ID'));
  const withdrawId = Number(process.env.WITHDRAW_ID ?? 0);
  const target = (process.env.RELOCK_TARGET ?? 'drainer').toLowerCase() === 'zero'
    ? zeroAddress
    : getAddress(requireEnv('ADVERSARY_DRAINER'));

  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const client = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  const req = await getWithdrawalRequest(client, validatorId, account.address, withdrawId);
  if (req.withdrawalAmount === 0n) throw new Error('no pending withdrawal — nothing to lock out of');
  const target_epoch = maturityEpoch(req.withdrawEpoch);
  const sprayStart = sprayStartBlockFor(target_epoch);
  const latestStart = latestStartBlockFor(target_epoch);

  console.log(`=== relock (anti-revoke attacker) ===`);
  console.log(`victim/attacker EOA: ${account.address}`);
  console.log(`re-delegating to:    ${target}${target === zeroAddress ? ' (clear delegation)' : ' (attacker drainer)'}`);
  console.log(`mode:                ${RELOCK_MODE}${RELOCK_MODE === 'grief' ? ` every ${RELOCK_EVERY} blocks` : ''}`);
  console.log(`flip window:         ${sprayStart}..${latestStart}`);

  // A 7702 self-delegation: the authorization re-delegates the EOA; the top-level call does
  // nothing. Self-sponsored, so the auth nonce is txNonce + 1 (the tx consumes the current nonce
  // first). Passed explicitly for the same reason as the atomic drainer — viem would otherwise
  // fetch it at blockTag 'pending' and diverge from the 'latest' tx nonce.
  const relock = async () => {
    const txNonce = await client.getTransactionCount({ address: account.address });
    const authorization = await wallet.signAuthorization({
      account, contractAddress: target, executor: 'self', nonce: txNonce + 1,
    });
    const hash = await wallet.sendTransaction({
      to: account.address, data: '0x', nonce: txNonce,
      gas: 100_000n, authorizationList: [authorization], chain,
    } as never);
    const r = await client.waitForTransactionReceipt({ hash });
    const codeAfter = await client.getCode({ address: account.address });
    const now = codeAfter && codeAfter.length === 48 ? '0x' + codeAfter.slice(8) : 'none';
    console.log(`  relock tx ${hash} -> ${r.status} block ${r.blockNumber}; victim now delegated to ${now}`);
    return r.status === 'success';
  };

  console.log(`waiting for the flip window...`);
  let fired = 0;
  for (;;) {
    const block = await client.getBlockNumber();
    const epoch = await getEpoch(client);
    if (block >= sprayStart && (RELOCK_MODE === 'grief' || fired === 0)) {
      if (fired === 0 || block % BigInt(RELOCK_EVERY) === 0n) {
        try { await relock(); fired++; } catch (e) { console.log(`  relock failed: ${(e as Error).message.split('\n')[0]}`); }
        if (RELOCK_MODE === 'single') break;
      }
    }
    if (epoch.epoch > target_epoch || block > latestStart + 200n) break;
    await sleep(POLL_MS);
  }
  console.log(`\ndone — fired ${fired} re-delegation(s). Now check whether arm still rescued: the`);
  console.log(`safe address balance is the answer, and 'THREAT delegation_changed' should appear in`);
  console.log(`arm's log if the watcher saw it.`);
  process.exit(0);
}

main().catch((e) => { console.error(`\nrelock failed: ${e.message}`); process.exit(1); });
