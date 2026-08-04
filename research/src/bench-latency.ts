/**
 * Latency benchmark — answers "what is the fastest version?" with measurements, not guesses.
 *
 * Needs NO funded key. Run this before spending a single test MON.
 *
 * On Monad the rescue is won or lost on two numbers, and this measures both:
 *
 *  1. HOW FAST WE NOTICE. There is no computable unlock block (FINDINGS.md Q6), so the
 *     trigger is a polled getEpoch(). Total reaction time is
 *     (poll interval / 2, on average) + (RPC round-trip). If an endpoint answers in 600ms,
 *     polling it every 100ms buys nothing — the round-trip dominates and you are just
 *     burning rate limit.
 *
 *  2. HOW FAST WE REACH THE LEADER. Monad has no global mempool; RPC nodes forward to the
 *     next few leaders. The endpoint that consistently reports a new block FIRST is the one
 *     closest to the leader, and is therefore both the best endpoint to poll and the first
 *     one to broadcast to. "Block observation lead" below measures exactly that, which is a
 *     far better proxy for proximity than a plain ping.
 *
 * Output is an ordered broadcast pool and a recommended poll interval.
 */
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { createPublicClient, http } from 'viem';
import { chainById, RPC_POOL, getEpoch, publicClientFor } from '@monrescue/shared';
import { writeArtifact } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 20);
const RACE_SECONDS = Number(process.env.BENCH_RACE_SECONDS ?? 45);

interface Stats {
  url: string;
  reachable: boolean;
  callP50: number;
  callP95: number;
  callMin: number;
  epochP50: number;
  /** How often this endpoint was the first to report a new block height. */
  firstToSeeBlock: number;
  /** Mean milliseconds behind the fastest endpoint for the same block height. */
  meanLagMs: number;
  error?: string;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

async function main() {
  const urls = [...(RPC_POOL[CHAIN_ID] ?? [])];
  const extra = process.env.EXTRA_RPC_URLS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  urls.push(...extra);

  console.log(`benchmarking ${urls.length} endpoint(s) on chain ${CHAIN_ID}`);
  console.log(`${SAMPLES} latency samples each, then a ${RACE_SECONDS}s block-observation race\n`);

  const chain = chainById(CHAIN_ID);
  const stats = new Map<string, Stats>();

  // --- phase 1: raw call latency ------------------------------------------
  for (const url of urls) {
    const s: Stats = {
      url, reachable: false, callP50: NaN, callP95: NaN, callMin: NaN,
      epochP50: NaN, firstToSeeBlock: 0, meanLagMs: NaN,
    };
    try {
      const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) });
      const callTimes: number[] = [];
      const epochTimes: number[] = [];

      for (let i = 0; i < SAMPLES; i++) {
        let t = Date.now();
        await client.getBlockNumber({ cacheTime: 0 });
        callTimes.push(Date.now() - t);

        // getEpoch() is the actual hot-path call, and it is an eth_call rather than a cheap
        // block read — public endpoints often rate-limit eth_call more aggressively.
        t = Date.now();
        await getEpoch(publicClientFor(CHAIN_ID, url));
        epochTimes.push(Date.now() - t);
      }

      callTimes.sort((a, b) => a - b);
      epochTimes.sort((a, b) => a - b);
      s.reachable = true;
      s.callP50 = pct(callTimes, 50);
      s.callP95 = pct(callTimes, 95);
      s.callMin = callTimes[0]!;
      s.epochP50 = pct(epochTimes, 50);
      console.log(
        `  ${url}\n    blockNumber p50=${s.callP50}ms p95=${s.callP95}ms min=${s.callMin}ms | getEpoch p50=${s.epochP50}ms`,
      );
    } catch (e) {
      s.error = (e as Error).message.split('\n')[0];
      console.log(`  ${url}\n    UNREACHABLE: ${s.error}`);
    }
    stats.set(url, s);
  }

  // --- phase 2: who sees new blocks first ---------------------------------
  // This is the proximity signal that actually predicts inclusion speed.
  const live = urls.filter((u) => stats.get(u)!.reachable);
  console.log(`\nracing ${live.length} endpoint(s) for ${RACE_SECONDS}s...`);

  const clients = new Map(live.map((u) => [u, createPublicClient({ chain, transport: http(u, { retryCount: 0 }) })]));
  const lastSeen = new Map<string, bigint>();
  /** First wall-clock time any endpoint reported a given height. */
  const firstAt = new Map<string, number>();
  const lags = new Map<string, number[]>(live.map((u) => [u, []]));

  const deadline = Date.now() + RACE_SECONDS * 1000;
  while (Date.now() < deadline) {
    await Promise.all(
      live.map(async (url) => {
        try {
          const bn = await clients.get(url)!.getBlockNumber({ cacheTime: 0 });
          const now = Date.now();
          if (lastSeen.get(url) === bn) return;
          lastSeen.set(url, bn);
          const key = bn.toString();
          if (!firstAt.has(key)) {
            firstAt.set(key, now);
            stats.get(url)!.firstToSeeBlock++;
            lags.get(url)!.push(0);
          } else {
            lags.get(url)!.push(now - firstAt.get(key)!);
          }
        } catch {
          /* a dropped sample must not end the race */
        }
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
  }

  for (const url of live) {
    const l = lags.get(url)!;
    stats.get(url)!.meanLagMs = l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : NaN;
  }

  // --- results -------------------------------------------------------------
  // Rank by observation lag first: proximity to the leader beats raw round-trip, because
  // inclusion depends on reaching the leader, not on how fast a node answers reads.
  const ranked = live
    .map((u) => stats.get(u)!)
    .sort((a, b) => (a.meanLagMs || 1e9) - (b.meanLagMs || 1e9) || a.callP50 - b.callP50);

  console.log(`\n=== ranked broadcast order ===`);
  ranked.forEach((s, i) => {
    console.log(
      `  ${i + 1}. ${s.url}\n     lag=${s.meanLagMs}ms firstToSeeBlock=${s.firstToSeeBlock} blockNumber_p50=${s.callP50}ms getEpoch_p50=${s.epochP50}ms`,
    );
  });

  const best = ranked[0];
  if (best) {
    // Polling faster than the round-trip cannot reduce detection latency; it only consumes
    // rate limit. Round up to a sane floor.
    const recommendedPoll = Math.max(100, Math.round(best.epochP50));
    const meanDetection = Math.round(recommendedPoll / 2 + best.epochP50);
    console.log(`\n=== recommendations ===`);
    console.log(`  poll endpoint:     ${best.url}`);
    console.log(`  EPOCH_POLL_MS:     ${recommendedPoll}`);
    console.log(`  expected detection latency: ~${meanDetection}ms (half a poll interval + one round-trip)`);
    console.log(`\n  Polling faster than ${best.epochP50}ms cannot help — the round-trip dominates.`);
    console.log(`  Set RPC_POOL order in packages/shared/src/chains.ts to the ranking above.`);
  }

  await writeArtifact(`bench-latency-${CHAIN_ID}`, {
    chainId: CHAIN_ID,
    samples: SAMPLES,
    raceSeconds: RACE_SECONDS,
    endpoints: [...stats.values()],
    rankedBroadcastOrder: ranked.map((s) => s.url),
    recommendedPollMs: best ? Math.max(100, Math.round(best.epochP50)) : null,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
