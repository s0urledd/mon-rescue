/**
 * Read-only state check. No key, no .env, no writes — safe to run from anywhere, including a
 * machine that is not the operator's node.
 *
 * Answers the question you actually have when you sit down: where is the position right now,
 * what can this account do, and how long until the next unlock.
 *
 *   VICTIM=0x... pnpm --filter @monrescue/research peek
 */
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { formatEther, getAddress } from 'viem';
import {
  RPC_POOL, publicClientFor, getEpoch, getDelegator, getWithdrawalRequest, getDelegations,
  epochsUntilClaimable, maturityEpoch, isEmptySlot, reserveFloor, boundaryBlockFor,
  earliestStartBlockFor, latestStartBlockFor,
} from '@monrescue/shared';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const SECONDS_PER_BLOCK = Number(process.env.SECONDS_PER_BLOCK ?? 0.301);
const SLOTS = Number(process.env.SLOTS_TO_PROBE ?? 8);

async function main() {
  const victim = getAddress(
    process.env.VICTIM ?? process.env.VICTIM_ADDRESS ?? '0x0000000000000000000000000000000000000000',
  );
  if (victim === '0x0000000000000000000000000000000000000000') {
    throw new Error('set VICTIM=0x... (the compromised account holding the position)');
  }

  const client = publicClientFor(CHAIN_ID, RPC_POOL[CHAIN_ID]![0]!);
  const [epoch, block, balance, code] = await Promise.all([
    getEpoch(client),
    client.getBlockNumber(),
    client.getBalance({ address: victim }),
    client.getCode({ address: victim }),
  ]);

  const delegated = !!code && code.toLowerCase().startsWith('0xef0100');
  const floor = delegated ? reserveFloor(balance) : 0n;

  console.log(`chain ${CHAIN_ID}  block ${block}  epoch ${epoch.epoch}` +
    `${epoch.inEpochDelayPeriod ? '  (past boundary — in the delay period)' : ''}`);
  console.log(`\naccount ${victim}`);
  console.log(`  balance   ${formatEther(balance)} MON`);
  console.log(`  delegated ${delegated ? `yes -> 0x${code!.slice(8)}` : 'no'}`);
  // The floor binds the sender too: the ending balance may only dip by the gas spend, so the
  // most this account can send as value is balance - min(balance, 10 MON). Below 10 MON while
  // delegated that is zero — it can pay gas and nothing else.
  console.log(`  can send  ${formatEther(balance > floor ? balance - floor : 0n)} MON as value` +
    `${delegated && balance <= floor ? '  (delegated and under 10 MON — gas only)' : ''}`);

  const validatorIds = await getDelegations(client, victim);
  if (validatorIds.length === 0) {
    console.log(`\nno active delegations reported.`);
    console.log(`  Note the precompile drops a delegator once next-epoch stake reaches zero, so a`);
    console.log(`  fully-unbonded position is invisible here. Probe slots with VALIDATOR_IDS=<id>.`);
  }

  const ids = process.env.VALIDATOR_IDS
    ? process.env.VALIDATOR_IDS.split(',').map((s) => BigInt(s.trim()))
    : validatorIds;

  let pending = 0;
  for (const id of ids) {
    const d = await getDelegator(client, id, victim);
    console.log(`\nvalidator ${id}`);
    console.log(`  stake   ${formatEther(d.stake)} MON`);
    console.log(`  rewards ${formatEther(d.unclaimedRewards)} MON`);
    for (let slot = 0; slot < SLOTS; slot++) {
      const r = await getWithdrawalRequest(client, id, victim, slot);
      if (isEmptySlot(r.withdrawalAmount, r.withdrawEpoch)) continue;
      pending++;
      const matures = maturityEpoch(r.withdrawEpoch);
      const left = epochsUntilClaimable(epoch, r.withdrawEpoch);
      const boundary = boundaryBlockFor(matures);
      const eta = left === 0n
        ? 'CLAIMABLE NOW'
        : `${left} epoch(s) — flip window blocks ${earliestStartBlockFor(matures)}..${latestStartBlockFor(matures)}` +
          `, ~${((Number(earliestStartBlockFor(matures) - block) * SECONDS_PER_BLOCK) / 3600).toFixed(1)}h`;
      console.log(`  slot ${slot}: ${formatEther(r.withdrawalAmount)} MON  activation ${r.withdrawEpoch}` +
        `  matures ${matures}  boundary ${boundary}`);
      console.log(`         ${eta}`);
    }
  }
  if (pending === 0 && ids.length > 0) console.log(`\nno pending withdrawals in slots 0..${SLOTS - 1}.`);
}

main().catch((e) => { console.error(`\npeek failed: ${e.message}`); process.exit(1); });
