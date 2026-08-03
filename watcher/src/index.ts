import { publicClientFor, getValidator, getEpoch, RPC_POOL } from '@monrescue/shared';
import { TelegramBot } from './telegram.js';
import {
  newWatchState, evaluateValidator, evaluateDelegatorEvent, type Alert,
} from './alerts.js';
import { watchForUnstakes, describeUnstake } from './intercept.js';

/**
 * MonRescue watcher — alert engine and public Telegram bot.
 *
 * Ships before the rescue path on purpose: everything it depends on is already verified
 * against live Monad (see research/FINDINGS.md), so it carries none of Q1's risk while
 * delivering the value delegators actually ask for.
 */

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 143);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
/** Unstake scanning is the critical path, so it runs far tighter than validator health. */
const UNSTAKE_SCAN_INTERVAL_MS = Number(process.env.UNSTAKE_SCAN_INTERVAL_MS ?? 3_000);

/**
 * eth_getLogs is capped at a 100-block range on the public endpoints, so any backfill must
 * page. Verified during Phase 0: `-32614: eth_getLogs is limited to a 100 range`.
 */
export const MAX_LOG_RANGE = 100n;

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const rpcUrl = process.env.RPC_URL ?? RPC_POOL[CHAIN_ID]?.[0];
  if (!rpcUrl) throw new Error(`no RPC configured for chain ${CHAIN_ID}`);

  const client = publicClientFor(CHAIN_ID, rpcUrl);
  const state = newWatchState();
  const subscriptions = new Map<number, Set<string>>();

  const epoch = await getEpoch(client);
  console.log(`watcher starting: chain ${CHAIN_ID}, epoch ${epoch.epoch}, rpc ${rpcUrl}`);

  let bot: TelegramBot | undefined;
  if (token) {
    bot = new TelegramBot({ token, subscriptions }, client);
    void bot.start();
  } else {
    console.warn('TELEGRAM_BOT_TOKEN not set — running the alert engine without the bot');
  }

  const emit = async (alerts: Alert[]) => {
    for (const a of alerts) {
      console.log(`[${a.severity}] ${a.kind} ${a.subject}: ${a.message}`);
      if (bot) await bot.broadcast(a);
    }
  };

  // Validator health loop. Validator ids are 1-based and dense, so we walk the configured
  // range rather than paging the consensus set on every tick.
  const maxValidatorId = BigInt(process.env.MAX_VALIDATOR_ID ?? 300);

  const tick = async () => {
    const now = Date.now();
    for (let id = 1n; id <= maxValidatorId; id++) {
      try {
        const v = await getValidator(client, id);
        // A validator id that was never created reads back as an empty record.
        if (v.stake === 0n && v.authAddress === '0x0000000000000000000000000000000000000000') continue;
        await emit(evaluateValidator(state, v, undefined, now));
      } catch (e) {
        // A single unreadable validator must not stop the sweep.
        if (process.env.DEBUG) console.error(`validator ${id}: ${(e as Error).message}`);
      }
    }
  };

  await tick();
  const timer = setInterval(() => void tick().catch((e) => console.error(e)), POLL_INTERVAL_MS);

  // Unstake interception — the highest-value signal we produce.
  //
  // The attacker holds the seed and unstakes the position themselves; they cannot take it for
  // WITHDRAWAL_DELAY, and their own Undelegate event hands us the validator, the slot, the
  // amount and the exact maturity epoch. So the moment the theft starts is the moment our clock
  // starts, with every parameter already known.
  //
  // Watched addresses come from bot subscriptions, so this list grows as users opt in.
  let stopIntercept = () => {};
  const rearmIntercept = () => {
    stopIntercept();
    const delegators = [...new Set([...subscriptions.values()].flatMap((s) => [...s]))].map(
      (a) => a as `0x${string}`,
    );
    if (delegators.length === 0) return;
    stopIntercept = watchForUnstakes({
      client,
      delegators,
      intervalMs: UNSTAKE_SCAN_INTERVAL_MS,
      onUnstake: async (event, plans) => {
        console.log(`[critical] unstake ${event.delegator} val=${event.validatorId} slot=${event.withdrawId}`);
        const plan = plans[0];
        const detail = plan
          ? `\n\nRescue window: flip blocks ${plan.flipWindowStart}..${plan.flipWindowEnd} ` +
            `(boundary ${plan.boundaryBlock}).`
          : '';
        await emit([{
          kind: 'unexpected_undelegate',
          severity: 'critical',
          subject: event.delegator.toLowerCase(),
          validatorId: event.validatorId,
          message: describeUnstake(event) + detail,
          firedAt: Date.now(),
        }]);
      },
    });
  };
  rearmIntercept();
  // Subscriptions change as users /watch, so re-derive the address list periodically.
  const interceptTimer = setInterval(rearmIntercept, 60_000);

  const shutdown = () => {
    clearInterval(timer);
    clearInterval(interceptTimer);
    stopIntercept();
    bot?.stop();
    console.log('watcher stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { evaluateValidator, evaluateDelegatorEvent, newWatchState };
