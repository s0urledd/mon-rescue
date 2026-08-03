/**
 * Speculative block subscriptions — the largest detection-latency win available.
 *
 * Monad extends the standard WebSocket subscriptions with two speculative variants,
 * `monadNewHeads` and `monadLogs`, which publish once a block is **Proposed and
 * speculatively executed** rather than waiting for it to be `Voted`. The documentation states
 * these arrive "approximately one second earlier on average" than the standard `newHeads` and
 * `logs`.
 *
 * A second is enormous here. Measured detection latency over remote HTTP polling was ~116ms,
 * and the whole unbonding race is decided inside a handful of 300ms blocks. Subscribing to
 * the speculative feed replaces polling entirely and moves us ahead of anyone watching the
 * confirmed feed.
 *
 * Three properties of this feed that must be handled, per the docs:
 *
 *  - Updates carry `blockId` (a unique id for THIS proposal, distinct from block number,
 *    because multiple proposals can exist at the same height) and `commitState`
 *    (`Proposed` | `Voted` | `Finalized` | `Verified`).
 *  - The same block produces multiple updates as its commit state advances, so consumers must
 *    dedupe by `blockId`.
 *  - A block may skip `Voted` and go straight from `Proposed` to `Finalized`.
 *  - **There is no abandonment event.** A proposal that never finalizes is superseded silently
 *    when a different `blockId` finalizes at the same height. Nothing tells you the first one
 *    died; you have to notice the replacement.
 *
 * For the rescue this asymmetry is acceptable and even desirable: acting on a speculative
 * block that is later abandoned costs one wasted transaction, while waiting for finality costs
 * the race. We optimise for acting early and tolerate the occasional wasted attempt.
 */

export type CommitState = 'Proposed' | 'Voted' | 'Finalized' | 'Verified';

export interface SpeculativeHead {
  blockId: string;
  commitState: CommitState;
  number: bigint;
  parentHash: string;
  timestamp: bigint;
}

export interface SpeculativeHeadEvent extends SpeculativeHead {
  /** False when a different blockId has already been seen at this height. */
  isFirstAtHeight: boolean;
  /** True when this blockId was already delivered at an earlier commit state. */
  isRestate: boolean;
}

/**
 * Track proposals so a consumer can dedupe and spot silent abandonment.
 *
 * Kept deliberately small and synchronous: this sits directly in the hot path, and the whole
 * point of using the speculative feed is to not spend milliseconds on bookkeeping.
 */
export class SpeculativeHeadTracker {
  private readonly seenBlockIds = new Map<string, CommitState>();
  private readonly heightToBlockIds = new Map<bigint, Set<string>>();
  /** Bound memory: the rescue window is minutes, not days. */
  private readonly retainHeights: number;

  constructor(retainHeights = 512) {
    this.retainHeights = retainHeights;
  }

  observe(head: SpeculativeHead): SpeculativeHeadEvent {
    const previousState = this.seenBlockIds.get(head.blockId);
    const isRestate = previousState !== undefined;
    this.seenBlockIds.set(head.blockId, head.commitState);

    let ids = this.heightToBlockIds.get(head.number);
    if (!ids) {
      ids = new Set();
      this.heightToBlockIds.set(head.number, ids);
    }
    const isFirstAtHeight = ids.size === 0;
    ids.add(head.blockId);

    this.prune();
    return { ...head, isFirstAtHeight, isRestate };
  }

  /**
   * Competing proposals seen at a height. More than one means at least one will be abandoned
   * without any event announcing it.
   */
  proposalsAtHeight(height: bigint): string[] {
    return [...(this.heightToBlockIds.get(height) ?? [])];
  }

  private prune(): void {
    if (this.heightToBlockIds.size <= this.retainHeights) return;
    const heights = [...this.heightToBlockIds.keys()].sort((a, b) => (a < b ? -1 : 1));
    const drop = heights.slice(0, heights.length - this.retainHeights);
    for (const h of drop) {
      for (const id of this.heightToBlockIds.get(h) ?? []) this.seenBlockIds.delete(id);
      this.heightToBlockIds.delete(h);
    }
  }
}

export interface SpeculativeSubscription {
  unsubscribe: () => void;
}

/**
 * Subscribe to `monadNewHeads` over a raw WebSocket.
 *
 * Written against the JSON-RPC wire protocol rather than viem's watchBlocks because these are
 * Monad-specific subscription names that viem does not model, and because the hot path wants
 * the frame as soon as it arrives with no abstraction in between.
 */
export function subscribeMonadNewHeads(
  wsUrl: string,
  onHead: (event: SpeculativeHeadEvent) => void,
  onError?: (err: Error) => void,
): SpeculativeSubscription {
  const tracker = new SpeculativeHeadTracker();
  let socket: WebSocket | undefined;
  let closed = false;

  const connect = () => {
    if (closed) return;
    try {
      socket = new WebSocket(wsUrl);
    } catch (e) {
      onError?.(e as Error);
      return;
    }

    socket.onopen = () => {
      socket?.send(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['monadNewHeads'] }),
      );
    };

    socket.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        const r = msg?.params?.result;
        if (!r?.blockId) return;
        onHead(
          tracker.observe({
            blockId: r.blockId,
            commitState: r.commitState as CommitState,
            number: BigInt(r.number),
            parentHash: r.parentHash,
            timestamp: BigInt(r.timestamp ?? 0),
          }),
        );
      } catch (e) {
        onError?.(e as Error);
      }
    };

    socket.onerror = () => onError?.(new Error('monadNewHeads socket error'));

    socket.onclose = () => {
      // Reconnect unless deliberately stopped: losing the feed mid-window is the one failure
      // that silently costs the rescue.
      if (!closed) setTimeout(connect, 500);
    };
  };

  connect();

  return {
    unsubscribe: () => {
      closed = true;
      socket?.close();
    },
  };
}
