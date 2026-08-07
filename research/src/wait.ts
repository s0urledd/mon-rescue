/**
 * Block until an epoch arrives, then exit. Read-only, no key.
 *
 * The workflow is full of multi-hour waits — a delegation activating, a withdrawal maturing —
 * and watching them by hand means either sitting on a terminal or coming back late. Late is the
 * expensive direction: the flip window is ~40 blocks and `arm` has to already be running when it
 * opens.
 *
 *   TARGET_EPOCH=1033 pnpm --filter @monrescue/research wait
 *   TARGET_EPOCH=1033 VALIDATOR_ID=40 VICTIM=0x… pnpm --filter @monrescue/research wait
 *
 * With VALIDATOR_ID and VICTIM it waits for the stake to actually read non-zero rather than for
 * the epoch number alone, which is the difference between "the epoch changed" and "the delegation
 * is usable". Exits 0 when the condition holds, 1 on timeout.
 */
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { formatEther, getAddress } from 'viem';
import { RPC_POOL, publicClientFor, getEpoch, getDelegator } from '@monrescue/shared';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const POLL_MS = Number(process.env.WAIT_POLL_MS ?? 45_000);
const TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS ?? 6 * 60 * 60 * 1000);

async function main() {
  const target = BigInt(process.env.TARGET_EPOCH ?? '0');
  if (target <= 0n) throw new Error('set TARGET_EPOCH=<epoch>');

  const validatorId = process.env.VALIDATOR_ID ? BigInt(process.env.VALIDATOR_ID) : undefined;
  const victim = process.env.VICTIM ? getAddress(process.env.VICTIM) : undefined;
  const wantStake = validatorId !== undefined && victim !== undefined;

  const client = publicClientFor(CHAIN_ID, RPC_POOL[CHAIN_ID]![0]!);
  const deadline = Date.now() + TIMEOUT_MS;

  console.log(`waiting for epoch ${target}` +
    `${wantStake ? ` and non-zero stake on validator ${validatorId}` : ''}...`);

  while (Date.now() < deadline) {
    try {
      const [epoch, block] = await Promise.all([getEpoch(client), client.getBlockNumber()]);
      if (epoch.epoch >= target) {
        if (!wantStake) {
          console.log(`\nepoch ${epoch.epoch} at block ${block}`);
          return;
        }
        const d = await getDelegator(client, validatorId!, victim!);
        if (d.stake > 0n) {
          console.log(`\nepoch ${epoch.epoch} at block ${block} — stake ${formatEther(d.stake)} MON ACTIVE`);
          return;
        }
        console.log(`epoch ${epoch.epoch} reached, stake still 0 — the snapshot may lag a block`);
      } else {
        console.log(`epoch ${epoch.epoch}, block ${block}`);
      }
    } catch (e) {
      // A failed read is not evidence of anything; keep polling.
      if (process.env.DEBUG) console.error(`poll: ${(e as Error).message.split('\n')[0]}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  throw new Error(`timed out after ${Math.round(TIMEOUT_MS / 60_000)} minutes`);
}

main().catch((e) => { console.error(`\nwait failed: ${e.message}`); process.exit(1); });
