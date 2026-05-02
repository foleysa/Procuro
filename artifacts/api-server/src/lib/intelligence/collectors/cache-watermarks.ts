/**
 * Shared ETag / Last-Modified watermark helpers for collectors that poll
 * upstream JSON endpoints on a recurring cron.
 *
 * Pattern (mirrors `runEcbFxRatesBackfill` from runtime.ts):
 *   1. Before each request, look up the watermark we recorded the last
 *      time we hit the same logical request (per-chunk for BLS, per-series
 *      for FRED). The watermark is `{ etag, lastModified }`.
 *   2. Send the request with `If-None-Match` / `If-Modified-Since` set
 *      from the watermark.
 *   3. If upstream returns `304 Not Modified`, the collector skips the
 *      payload entirely — no parse, no draft fan-out, no MERGE traffic.
 *      The watermark is preserved as-is for the next run.
 *   4. On a `200`, capture the new `ETag` / `Last-Modified` and persist
 *      them after the run completes so the next poll can short-circuit.
 *
 * Storage is the existing `collector_audit_log` table — one row per run
 * with `event = "cache_watermark"` and `metadata = { entries: { [key]:
 * { etag, lastModified } } }`. Reading the most recent row gives us the
 * full watermark map; writing a fresh row makes the next run's read O(1).
 *
 * Failure mode: every DB op here is best-effort. A read failure returns
 * an empty map (cold-start equivalent → full fetch). A write failure is
 * logged and swallowed so a transient `collector_audit_log` outage can
 * never break a successful collector run. This keeps the helper safe to
 * use from collectors that are also exercised by unit tests without a
 * live `DATABASE_URL`.
 */

import { and, desc, eq } from "drizzle-orm";
import { db, collectorAuditLogTable } from "@workspace/db";
import { newId } from "../../ids";
import { logger } from "../../logger";

export interface CacheHeaders {
  etag: string | null;
  lastModified: string | null;
}

/** Audit-log event name used for both reads and writes. */
export const CACHE_WATERMARK_EVENT = "cache_watermark";

/**
 * Read the most recent stored cache headers for a collector and return a
 * per-request-key map of `{ etag, lastModified }`.
 *
 * Returns an empty map when no watermark exists yet (first-run equivalent)
 * or when the read fails. Callers always fall through to the full fetch
 * on an empty map, so a missed watermark is at worst a wasted HTTP round
 * trip — never a missed insert.
 */
export async function readCacheWatermarks(
  collectorId: string,
): Promise<Map<string, CacheHeaders>> {
  try {
    const [row] = await db
      .select()
      .from(collectorAuditLogTable)
      .where(
        and(
          eq(collectorAuditLogTable.collectorId, collectorId),
          eq(collectorAuditLogTable.event, CACHE_WATERMARK_EVENT),
        ),
      )
      .orderBy(desc(collectorAuditLogTable.createdAt))
      .limit(1);
    if (!row) return new Map();
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const entries = meta["entries"];
    if (!entries || typeof entries !== "object") return new Map();
    const out = new Map<string, CacheHeaders>();
    for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Record<string, unknown>;
      const etag = typeof e["etag"] === "string" ? (e["etag"] as string) : null;
      const lastModified =
        typeof e["lastModified"] === "string"
          ? (e["lastModified"] as string)
          : null;
      if (etag === null && lastModified === null) continue;
      out.set(k, { etag, lastModified });
    }
    return out;
  } catch (err) {
    logger.warn(
      { err, collectorId },
      "readCacheWatermarks failed; falling through to full fetch",
    );
    return new Map();
  }
}

/**
 * Persist the cache headers a run observed. Best-effort — DB failures are
 * logged and swallowed so an audit-log outage cannot break a successful
 * collector run.
 *
 * IMPORTANT: An empty map is persisted as `entries: {}`, NOT skipped.
 * If a previous run wrote a non-empty watermark and this run dropped
 * every entry (e.g. upstream stopped sending cache headers), the next
 * `readCacheWatermarks` must see the cleared state — otherwise it will
 * keep replaying the stale validators forever and either short-circuit
 * spuriously or burn quota on conditional requests the upstream is no
 * longer honouring. Entries with both `etag` and `lastModified` null
 * are still filtered out (they carry no useful conditional value).
 */
export async function writeCacheWatermarks(
  collectorId: string,
  entries: Map<string, CacheHeaders>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const obj: Record<string, CacheHeaders> = {};
  for (const [k, v] of entries) {
    if (v.etag === null && v.lastModified === null) continue;
    obj[k] = v;
  }
  try {
    await db.insert(collectorAuditLogTable).values({
      id: newId("aud"),
      collectorId,
      event: CACHE_WATERMARK_EVENT,
      metadata: { entries: obj, ...extra },
    });
  } catch (err) {
    logger.warn(
      { err, collectorId },
      "writeCacheWatermarks failed; subsequent runs will refetch",
    );
  }
}

/**
 * Build the conditional-request headers (`If-None-Match` /
 * `If-Modified-Since`) from a watermark, or an empty record if the
 * watermark is missing or empty. Both headers are sent when both are
 * known — upstreams typically honour whichever they set originally and
 * ignore the other.
 */
export function buildConditionalHeaders(
  watermark: CacheHeaders | undefined,
): Record<string, string> {
  if (!watermark) return {};
  const headers: Record<string, string> = {};
  if (watermark.etag) headers["If-None-Match"] = watermark.etag;
  if (watermark.lastModified) {
    headers["If-Modified-Since"] = watermark.lastModified;
  }
  return headers;
}

/**
 * Extract `ETag` / `Last-Modified` from a `Response`. Returns `null` for
 * any header the upstream omitted so the watermark accurately reflects
 * "we have nothing useful to short-circuit on next time" rather than
 * silently re-using a stale value.
 */
export function extractCacheHeaders(res: Response): CacheHeaders {
  return {
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
}

/**
 * Pending post-insert commit registry.
 *
 * Mirrors the ECB historical-archive pattern (Task #127): the
 * `cache_watermark` audit row must only advance AFTER the runtime has
 * successfully persisted the run's drafts via `insertSignalsWithDedupe`.
 * If we wrote the watermark from inside `collect()` itself, a downstream
 * insert failure would leave the next run with an advanced watermark and
 * a `304 Not Modified` short-circuit — silently skipping data we never
 * actually committed.
 *
 * Flow:
 *   1. Inside `collect()`, the collector computes the new watermark map
 *      and calls `setPendingCacheCommit(this.id, () => writeCacheWatermarks(...))`.
 *      Nothing is written to the DB yet.
 *   2. The collector exposes `takePendingPostInsertCommit()` which
 *      returns the queued commit (and clears the slot).
 *   3. The runtime invokes the commit only after Postgres
 *      `insertSignalsWithDedupe` returns successfully.
 *
 * Single-slot per collector by design. The runtime serializes runs of
 * the same collector — there is no in-process concurrency to guard
 * against. A leftover slot from a crashed run is harmless: it gets
 * overwritten by the next run's `setPendingCacheCommit`. Importantly,
 * a leftover commit will NOT fire spuriously because nothing other
 * than `takePendingPostInsertCommit` (called from runtime, gated on a
 * successful insert) consumes the slot.
 */
const pendingCacheCommits = new Map<string, () => Promise<void>>();

/**
 * Queue a watermark write to be committed by the runtime after a
 * successful insert. Overwrites any stale slot from a prior crashed
 * run — see the comment above for why that's safe.
 */
export function setPendingCacheCommit(
  collectorId: string,
  commit: () => Promise<void>,
): void {
  pendingCacheCommits.set(collectorId, commit);
}

/**
 * Atomically read-and-clear the pending commit for a collector.
 * Returns `null` when the collector did not queue one (collectors that
 * don't use the cache-watermark pattern, or runs that took an early
 * exit before `setPendingCacheCommit`).
 *
 * The runtime calls this after `insertSignalsWithDedupe` succeeds and
 * invokes the returned callback (best-effort, errors logged). Test code
 * may also call it directly to simulate the post-insert step.
 */
export function takePendingCacheCommit(
  collectorId: string,
): (() => Promise<void>) | null {
  const fn = pendingCacheCommits.get(collectorId);
  if (!fn) return null;
  pendingCacheCommits.delete(collectorId);
  return fn;
}
