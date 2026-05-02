/**
 * In-process publisher for newly persisted market_signals rows.
 *
 * The collector runtime calls `publishMarketSignalIds` after a successful
 * `insertSignalsWithDedupe` with the row ids that were *actually* inserted
 * (duplicates are not republished). The War Room SSE endpoint subscribes
 * to this stream, refetches the matching rows under each connected
 * tenant's scope + disclosure policy, and pushes the resulting DTOs to
 * the browser without any polling round-trip.
 *
 * Scope: single-process. Replit deployments run a single api-server
 * instance, so an EventEmitter is sufficient. If we ever go multi-process
 * we'll swap this for a Postgres LISTEN/NOTIFY bridge or a Redis pub/sub —
 * the call sites won't change.
 */

import { EventEmitter } from "node:events";

export interface MarketSignalPublication {
  /** Persisted `market_signals.id` values that were freshly inserted. */
  ids: string[];
}

const bus = new EventEmitter();
// Many SSE clients can connect simultaneously; node's default 10-listener
// warning would fire on a busy war-room session. Disable the cap — leak
// pressure here would manifest as memory growth on the long-lived
// EventEmitter, which we'd see in the heap regardless of the warning.
bus.setMaxListeners(0);

const CHANNEL = "market-signals.inserted";

export function publishMarketSignalIds(ids: readonly string[]): void {
  if (ids.length === 0) return;
  bus.emit(CHANNEL, { ids: [...ids] } satisfies MarketSignalPublication);
}

/**
 * Subscribe to newly inserted market-signal ids. Returns an unsubscribe
 * function — callers (the SSE handler) MUST call it on connection close
 * or the EventEmitter will retain references to dead res objects.
 */
export function subscribeMarketSignalIds(
  handler: (p: MarketSignalPublication) => void,
): () => void {
  bus.on(CHANNEL, handler);
  return () => {
    bus.off(CHANNEL, handler);
  };
}
