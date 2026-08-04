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
  // Polling and broadcasting are DIFFERENT questions and must be ranked differently.
  //
  //  - Detection latency is bounded by the round-trip of the endpoint we poll. Nothing else
  //    enters into it. A co-located node answering in 3ms beats a remote one answering in 53ms
  //    by a factor of ~12, regardless of where either sits relative to the leader.
  //
  //  - Inclusion depends on reaching the leader, so broadcast order is ranked by which endpoint
  //    reports new blocks first. `firstToSeeBlock` is the cleaner signal here: mean lag is noisy
  //    when two endpoints are near-simultaneous, because each one's lag is only sampled on the
  //    rounds it happens to lose.
  //
  // An earlier version ranked both by lag and recommended polling a remote endpoint over a
  // local node, throwing away an order of magnitude of detection latency.
  const byRoundTrip = live.map((u) => stats.get(u)!).sort((a, b) => a.epochP50 - b.epochP50);
  const byLeaderProximity = live
    .map((u) => stats.get(u)!)
    .sort((a, b) => b.firstToSeeBlock - a.firstToSeeBlock || (a.meanLagMs || 1e9) - (b.meanLagMs || 1e9));

  console.log(`\n=== broadcast order (closest to the leader first) ===`);
  byLeaderProximity.forEach((s, i) => {
    console.log(
      `  ${i + 1}. ${s.url}\n     firstToSeeBlock=${s.firstToSeeBlock} lag=${s.meanLagMs}ms`,
    );
  });

  console.log(`\n=== poll endpoint (lowest round-trip first) ===`);
  byRoundTrip.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.url}\n     getEpoch p50=${s.epochP50}ms blockNumber p50=${s.callP50}ms`);
  });

  const poll = byRoundTrip[0];
  let recommendedPoll: number | null = null;
  if (poll) {
    // A sub-10ms round-trip means the node is effectively local, so there is no shared rate
    // limit to protect and we can poll tightly. A remote endpoint gets a 100ms floor to avoid
    // burning quota we will want during the burst.
    const isLocal = poll.epochP50 < 10;
    recommendedPoll = Math.max(isLocal ? 10 : 100, Math.round(poll.epochP50));
    const meanDetection = Math.round(recommendedPoll / 2 + poll.epochP50);

    console.log(`\n=== recommendations ===`);
    console.log(`  poll endpoint:  ${poll.url}${isLocal ? '  (local — poll tightly)' : ''}`);
    console.log(`  EPOCH_POLL_MS:  ${recommendedPoll}`);
    console.log(`  expected detection latency: ~${meanDetection}ms (half a poll interval + one round-trip)`);
    console.log(`\n  Polling faster than ${poll.epochP50}ms cannot help — the round-trip dominates.`);

    const slowest = byRoundTrip[byRoundTrip.length - 1]!;
    if (slowest.epochP50 > poll.epochP50 * 3) {
      console.log(
        `  Polling ${slowest.url} instead would cost ~${Math.round(
          Math.max(100, slowest.epochP50) / 2 + slowest.epochP50,
        )}ms — ${(slowest.epochP50 / Math.max(1, poll.epochP50)).toFixed(0)}x worse. Use the local node.`,
      );
    }
    console.log(`\n  Set MONAD_HTTP_URL=${poll.url} (or MONAD_IPC_PATH if the node is on this host).`);
    console.log(`  Set RPC_POOL order in packages/shared/src/chains.ts to the broadcast ranking.`);
  }

  await writeArtifact(`bench-latency-${CHAIN_ID}`, {
    chainId: CHAIN_ID,
    samples: SAMPLES,
    raceSeconds: RACE_SECONDS,
    endpoints: [...stats.values()],
    rankedBroadcastOrder: byLeaderProximity.map((s) => s.url),
    recommendedPollEndpoint: poll?.url ?? null,
    recommendedPollMs: recommendedPoll,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
