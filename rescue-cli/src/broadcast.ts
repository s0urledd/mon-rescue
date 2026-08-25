import { createPublicClient, http } from 'viem';
import { chainById, RPC_POOL } from '@monrescue/shared';

/**
 * Multi-RPC simultaneous broadcast.
 *
 * Monad has no private mempool and no bundle relay, so there is no way to buy inclusion
 * priority out-of-band. The only levers are latency to the leader and fee. This module owns
 * the latency lever: fire the same signed transaction at every endpoint at once and keep
 * whichever result comes back first.
 *
 * Deliberately takes a PRE-SIGNED raw transaction. Signing inside the hot path would add
 * milliseconds at the exact moment they cost the most.
 */

export interface BroadcastResult {
  hash: `0x${string}` | undefined;
  /** Per-endpoint outcome, kept for post-mortem — losing the race is a debuggable event. */
  attempts: { url: string; ms: number; hash?: string; error?: string }[];
}

export async function broadcastEverywhere(
  chainId: number,
  rawTx: `0x${string}`,
  urls: readonly string[] = RPC_POOL[chainId] ?? [],
): Promise<BroadcastResult> {
  if (urls.length === 0) throw new Error(`no RPC endpoints configured for chain ${chainId}`);

  const attempts: BroadcastResult['attempts'] = [];
  const chain = chainById(chainId);

  const sends = urls.map(async (url) => {
    const started = Date.now();
    try {
      const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) });
      const hash = await client.sendRawTransaction({ serializedTransaction: rawTx });
      attempts.push({ url, ms: Date.now() - started, hash });
      return hash;
    } catch (e) {
      // An endpoint rejecting the transaction is expected once another has already relayed
      // it — "already known" is a success signal, not a failure.
      attempts.push({ url, ms: Date.now() - started, error: (e as Error).message.split('\n')[0] });
      throw e;
    }
  });

  let hash: `0x${string}` | undefined;
  try {
    hash = await Promise.any(sends);
  } catch {
    hash = undefined;
  }
  // Do NOT block on the slow endpoints. Promise.any already returned the first acceptance — the
  // local node at ~10ms. The previous `await Promise.allSettled(sends)` here also waited on the
  // remote RPCs (~230ms measured), and that latency is per-broadcast: it serialized a cluster's
  // members across ~3 blocks and defeated the entire point of firing them into ONE flip block
  // (Q33). Let the stragglers settle detached — they still push into `attempts` for the
  // post-mortem; the array simply is not guaranteed complete at the moment of return, which the hot
  // path does not need. allSettled never rejects and attaches a handler to every send, so nothing
  // goes unhandled.
  void Promise.allSettled(sends);

  return { hash, attempts };
}
