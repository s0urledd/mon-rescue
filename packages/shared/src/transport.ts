import { createPublicClient, http, webSocket, fallback } from 'viem';
import type { PublicClient, Transport } from 'viem';
import { chainById, RPC_POOL } from './chains.js';

/**
 * Transport selection, ordered by latency.
 *
 * The hot path is latency-bound, and the single largest win available is not a faster remote
 * endpoint — it is not being remote at all. Running the daemon on the same machine as a Monad
 * node removes the network round-trip entirely, which the benchmark measured at ~50-70ms
 * against public HTTPS endpoints. That round-trip is the floor on how fast we can notice an
 * epoch transition, so removing it is worth more than any amount of tuning on top of it.
 *
 * Preference order:
 *   1. IPC (unix socket) — same machine, no TCP, no TLS, no HTTP framing
 *   2. WebSocket to localhost — persistent connection, no per-request handshake
 *   3. HTTP to localhost — still no network, but pays HTTP framing per call
 *   4. Remote HTTPS — the fallback, and what the public pool is for
 *
 * Broadcast is a separate concern from polling: we still fan the signed transaction out to
 * every remote endpoint as well, because a local node forwards to only the leaders it knows
 * and redundancy costs nothing once the transaction is signed.
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
export function transportConfigFromEnv(chainId: number): TransportConfig {
  return {
    chainId,
    ipcPath: process.env.MONAD_IPC_PATH,
    wsUrl: process.env.MONAD_WS_URL,
    httpUrl: process.env.MONAD_HTTP_URL ?? process.env.RPC_URL,
    remoteUrls: RPC_POOL[chainId],
  };
}
