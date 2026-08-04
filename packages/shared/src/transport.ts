import { createPublicClient, http, webSocket, fallback } from 'viem';
import type { PublicClient, Transport } from 'viem';
import { chainById, RPC_POOL } from './chains.js';

/**
 * Transport selection.
 *
 * **If you run your own node, it wins for everything.** Detection latency is bounded purely by
 * the round-trip of whatever endpoint we poll, and a co-located node answers in single-digit
 * milliseconds against 50-70ms for a public HTTPS endpoint. No amount of tuning on top of a
 * remote endpoint recovers that gap. The public pool exists as failover, not as a peer.
 *
 * Preference order:
 *   1. IPC (unix socket) — same host, no TCP, no TLS, no HTTP framing
 *   2. WebSocket to localhost — persistent connection, no per-request handshake
 *   3. HTTP to localhost — still no network, pays HTTP framing per call
 *   4. Remote HTTPS — failover only
 *
 * **Why we still broadcast to several endpoints.**
 *
 * Three things are documented, and the distinction between them matters:
 *
 *  - "Since the function is deterministic, everyone arrives at the same leader schedule." The
 *    schedule itself is shared, so no node knows a leader the others do not.
 *  - "the consensus process forwards the transaction to `N` upcoming leader validator nodes.
 *    Currently, `N` is set to 3."
 *  - "**The owner node** of the transaction monitors for that transaction in subsequent blocks.
 *    If it doesn't see the transaction in the next `N` blocks, it will re-send to the next `N`
 *    leaders. It repeats this behavior for a total of `K` times. Currently, `K` is set to 3."
 *
 * That third point is the one that matters, and an earlier version of this comment missed it.
 * The retry cycle belongs to **the owner node** — the node the transaction was submitted to. So
 * every endpoint we submit to becomes an independent owner running its own K=3 cycle of
 * re-forwarding. Across the retry window that is genuinely more forwarding, reaching leaders
 * further down the schedule, not merely the same three repeatedly.
 *
 * At a single instant with nodes in sync, they do all forward to the same three, so there is no
 * coverage gain from the first submission alone. But "in sync" is an assumption: which leaders
 * are *next* depends on the round each node currently believes is current, and rounds advance on
 * timeout whether or not a block is produced. A node even slightly behind forwards to a
 * partially different set. **The docs never state that all nodes compute the same next-N at the
 * same moment — that is inference, not documentation.**
 *
 * And underneath all of it, the plain failover case: our node being down, lagging, restarting or
 * rate-limiting at the unlock block silently loses the rescue, and is not detectable from inside
 * the process fast enough to react.
 */

export interface TransportConfig {
  chainId: number;
  /** Path to the node's IPC socket, e.g. /home/monad/monad.sock */
  ipcPath?: string;
  /** ws:// or wss:// endpoint, ideally localhost */
  wsUrl?: string;
  /** http:// endpoint, ideally localhost */
  httpUrl?: string;
  /** Remote endpoints used as a last resort for reads, and always for broadcast. */
  remoteUrls?: readonly string[];
}

export type TransportKind = 'ipc' | 'websocket' | 'http-local' | 'http-remote';

export interface ResolvedTransport {
  kind: TransportKind;
  transport: Transport;
  description: string;
}

function isLocal(url: string): boolean {
  return /^(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}

/**
 * Build the lowest-latency transport available from the config.
 *
 * IPC needs viem's node entrypoint, which is not importable in every environment (it pulls in
 * `node:net`). It is loaded lazily and only when an ipcPath is actually configured, so that a
 * browser or edge build of this package does not break.
 */
export async function resolveTransport(cfg: TransportConfig): Promise<ResolvedTransport> {
  if (cfg.ipcPath) {
    try {
      const { ipc } = await import('viem/node');
      return {
        kind: 'ipc',
        transport: ipc(cfg.ipcPath),
        description: `IPC socket ${cfg.ipcPath} (no network round-trip)`,
      };
    } catch (e) {
      // Fall through rather than fail: a misconfigured IPC path must not take the rescue
      // offline when a working HTTP endpoint is available.
      console.warn(
        `IPC transport unavailable (${(e as Error).message}); falling back to a slower transport`,
      );
    }
  }

  if (cfg.wsUrl) {
    return {
      kind: 'websocket',
      transport: webSocket(cfg.wsUrl, { retryCount: 0 }),
      description: `WebSocket ${cfg.wsUrl}${isLocal(cfg.wsUrl) ? ' (local)' : ' (remote)'}`,
    };
  }

  if (cfg.httpUrl) {
    return {
      kind: isLocal(cfg.httpUrl) ? 'http-local' : 'http-remote',
      transport: http(cfg.httpUrl, { retryCount: 0 }),
      description: `HTTP ${cfg.httpUrl}${isLocal(cfg.httpUrl) ? ' (local)' : ' (remote)'}`,
    };
  }

  const remotes = cfg.remoteUrls ?? RPC_POOL[cfg.chainId] ?? [];
  if (remotes.length === 0) throw new Error(`no transport configured for chain ${cfg.chainId}`);
  return {
    kind: 'http-remote',
    transport: fallback(remotes.map((u) => http(u, { retryCount: 0 }))),
    description: `remote HTTP fallback over ${remotes.length} endpoint(s)`,
  };
}

export async function localFirstClient(cfg: TransportConfig): Promise<{
  client: PublicClient;
  resolved: ResolvedTransport;
}> {
  const resolved = await resolveTransport(cfg);
  const client = createPublicClient({
    chain: chainById(cfg.chainId),
    transport: resolved.transport,
  });
  return { client, resolved };
}

/**
 * Read transport config from the environment.
 *
 * MONAD_IPC_PATH is the one worth setting when the daemon shares a machine with a node.
 */
/**
 * Conventional local node endpoints. Used when nothing is configured, so that running beside a
 * node needs no setup at all — the common case should not require remembering a variable.
 */
export const DEFAULT_LOCAL_HTTP = 'http://127.0.0.1:8080';
export const DEFAULT_LOCAL_WS = 'ws://127.0.0.1:8081';

export function transportConfigFromEnv(chainId: number): TransportConfig {
  return {
    chainId,
    ipcPath: process.env.MONAD_IPC_PATH,
    wsUrl: process.env.MONAD_WS_URL,
    httpUrl: process.env.MONAD_HTTP_URL ?? process.env.RPC_URL,
    remoteUrls: RPC_POOL[chainId],
  };
}

/**
 * Probe a local node and fall back to the public pool if it is not there.
 *
 * Preferred over `transportConfigFromEnv` at startup: it means a correctly-running local node is
 * used automatically, and its absence is reported loudly rather than silently costing an order
 * of magnitude of detection latency.
 */
export async function detectLocalNode(
  chainId: number,
  timeoutMs = 1500,
): Promise<{ httpUrl?: string; wsUrl?: string; found: boolean; detail: string }> {
  const httpUrl = process.env.MONAD_HTTP_URL ?? process.env.RPC_URL ?? DEFAULT_LOCAL_HTTP;
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { result?: string };
    const seen = json.result ? Number(BigInt(json.result)) : undefined;
    if (seen !== chainId) {
      return {
        found: false,
        detail: `${httpUrl} answered for chain ${seen}, expected ${chainId} — not using it`,
      };
    }
    return {
      httpUrl,
      wsUrl: process.env.MONAD_WS_URL ?? DEFAULT_LOCAL_WS,
      found: true,
      detail: `local node at ${httpUrl} (chain ${seen})`,
    };
  } catch (e) {
    return {
      found: false,
      detail:
        `no local node at ${httpUrl} (${(e as Error).message.split('\n')[0]}). ` +
        `Falling back to public endpoints, which costs roughly an order of magnitude of ` +
        `detection latency.`,
    };
  }
}
