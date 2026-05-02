import { db, csvIngestMetricsTable, jobsTable } from "@workspace/db";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { newId } from "./ids";
import { logger } from "./logger";

/**
 * Per-upload throughput sample for a streaming CSV ingest. Captured from
 * the `/ingest/csv-stream` route after `streamCsvEntity` resolves so the
 * System page can chart real customer rows/sec drift over time without
 * scraping logs.
 *
 * Best-effort by design: any failure here is swallowed (logged at warn)
 * because a failed metric write must never make a successful upload look
 * like it failed to the operator. The next upload will write its own row
 * and trends recover automatically.
 */
export async function recordCsvIngestMetric(args: {
  orgId: string;
  entity: string;
  rowsParsed: number;
  rowsInserted: number;
  durationMs: number;
  bytesProcessed: number;
}): Promise<void> {
  try {
    await db.insert(csvIngestMetricsTable).values({
      id: newId("csvm"),
      orgId: args.orgId,
      entity: args.entity,
      rowsParsed: Math.max(0, Math.floor(args.rowsParsed)),
      rowsInserted: Math.max(0, Math.floor(args.rowsInserted)),
      durationMs: Math.max(0, Math.floor(args.durationMs)),
      bytesProcessed: Math.max(0, Math.floor(args.bytesProcessed)),
    });
  } catch (err) {
    logger.warn(
      { err, orgId: args.orgId, entity: args.entity },
      "recordCsvIngestMetric failed (non-fatal)",
    );
  }
}

export interface CsvIngestRecentRun {
  id: string;
  orgId: string;
  entity: string;
  rowsParsed: number;
  rowsInserted: number;
  durationMs: number;
  bytesProcessed: number;
  rowsPerSecond: number;
  createdAt: string;
}

export interface CsvIngestEntityDay {
  /** ISO date for the start of the UTC day. */
  day: string;
  uploadCount: number;
  totalRows: number;
  /** Median rows/sec across the day's uploads. Zero when no uploads. */
  p50RowsPerSecond: number;
  /** 95th-percentile rows/sec across the day's uploads. */
  p95RowsPerSecond: number;
}

export interface CsvIngestEntityTrend {
  entity: string;
  uploadCount: number;
  totalRows: number;
  p50RowsPerSecond: number;
  p95RowsPerSecond: number;
  /** Per-day rollups, oldest → newest, length === windowDays. Days with
   *  no uploads have all-zero counters so the sparkline keeps a stable
   *  X axis. */
  days: CsvIngestEntityDay[];
}

export interface CsvIngestMetricsResponse {
  recent: CsvIngestRecentRun[];
  entities: CsvIngestEntityTrend[];
  windowDays: number;
}

/**
 * Returns recent CSV ingest runs (newest first, capped at `recentLimit`)
 * plus per-entity 7-day trend rollups (oldest → newest day) so the
 * System page can render both a recent-uploads table and a sparkline
 * per entity from a single round-trip.
 *
 * The window is always anchored to "now" minus N days so a slowly-drifting
 * dev environment stops showing trends for entities that have not been
 * uploaded recently (i.e. an entity that hasn't been touched in 8 days
 * disappears from the trend list rather than showing a stale sparkline).
 */
export async function getCsvIngestMetricsSummary(args: {
  windowDays?: number;
  recentLimit?: number;
}): Promise<CsvIngestMetricsResponse> {
  const windowDays = Math.max(1, Math.min(30, args.windowDays ?? 7));
  const recentLimit = Math.max(1, Math.min(200, args.recentLimit ?? 25));
  const now = new Date();
  // Anchor the trend window to UTC day boundaries so the SQL window,
  // the day skeleton below, and per-entity totals all describe the
  // *same* set of samples. Without this, samples from the partial
  // calendar day older than the oldest sparkline bucket would still
  // count toward p50/p95 totals, making the displayed trend disagree
  // with the aggregate stats on the same row.
  const todayStartUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const windowStart = new Date(
    todayStartUtc - (windowDays - 1) * 24 * 60 * 60 * 1000,
  );

  const recentRows = await db
    .select()
    .from(csvIngestMetricsTable)
    .orderBy(desc(csvIngestMetricsTable.createdAt))
    .limit(recentLimit);

  const recent: CsvIngestRecentRun[] = recentRows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    entity: r.entity,
    rowsParsed: r.rowsParsed,
    rowsInserted: r.rowsInserted,
    durationMs: r.durationMs,
    bytesProcessed: r.bytesProcessed,
    rowsPerSecond: computeRowsPerSecond(r.rowsInserted, r.durationMs),
    createdAt: toIsoString(r.createdAt),
  }));

  // Pull every metric row in the trend window in one query and bucket
  // client-side: trend rendering works on at most ~30 days × N entities
  // × <100 uploads/day, so an in-process group-by stays well under the
  // size where a SQL `date_trunc` + GROUP BY would meaningfully win.
  const trendRows = await db
    .select()
    .from(csvIngestMetricsTable)
    .where(
      and(
        gte(csvIngestMetricsTable.createdAt, windowStart),
        lte(csvIngestMetricsTable.createdAt, now),
      ),
    );

  interface DayBucket {
    rps: number[];
    rows: number;
  }
  interface EntityBucket {
    days: Map<string, DayBucket>;
    rps: number[];
    rows: number;
    uploads: number;
  }
  const buckets = new Map<string, EntityBucket>();

  for (const r of trendRows) {
    const ts = toDate(r.createdAt);
    const day = ymdUtc(ts);
    const rps = computeRowsPerSecond(r.rowsInserted, r.durationMs);

    let entityBucket = buckets.get(r.entity);
    if (!entityBucket) {
      entityBucket = { days: new Map(), rps: [], rows: 0, uploads: 0 };
      buckets.set(r.entity, entityBucket);
    }
    entityBucket.uploads += 1;
    entityBucket.rows += r.rowsInserted;
    entityBucket.rps.push(rps);

    let dayBucket = entityBucket.days.get(day);
    if (!dayBucket) {
      dayBucket = { rps: [], rows: 0 };
      entityBucket.days.set(day, dayBucket);
    }
    dayBucket.rps.push(rps);
    dayBucket.rows += r.rowsInserted;
  }

  // Build the day skeleton (oldest → newest) anchored to the same
  // UTC-day boundaries as `windowStart` so every sample bucketed
  // above lands in exactly one rendered day, and no rendered day is
  // older than the SQL window. Empty-day entities still render a flat
  // sparkline over the same X axis as busy ones.
  const daySkeleton: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(todayStartUtc - i * 24 * 60 * 60 * 1000);
    daySkeleton.push(ymdUtc(d));
  }

  const entities: CsvIngestEntityTrend[] = [];
  for (const [entity, eb] of buckets.entries()) {
    const days: CsvIngestEntityDay[] = daySkeleton.map((day) => {
      const db_ = eb.days.get(day);
      const samples = db_?.rps ?? [];
      return {
        day,
        uploadCount: samples.length,
        totalRows: db_?.rows ?? 0,
        p50RowsPerSecond: percentile(samples, 0.5),
        p95RowsPerSecond: percentile(samples, 0.95),
      };
    });

    entities.push({
      entity,
      uploadCount: eb.uploads,
      totalRows: eb.rows,
      p50RowsPerSecond: percentile(eb.rps, 0.5),
      p95RowsPerSecond: percentile(eb.rps, 0.95),
      days,
    });
  }

  // Busiest pipelines first; tiebreak on entity name so the order is
  // stable across reloads.
  entities.sort(
    (a, b) =>
      b.uploadCount - a.uploadCount || a.entity.localeCompare(b.entity),
  );

  return { recent, entities, windowDays };
}

// ──────────────────────────────────────────────────────────────────────────
// CSV ingest job throughput history (#157)
//
// Powers the time-series sparkline on the System page's "CSV ingest
// throughput" card. Aggregates `ingest_csv` job rows server-side into
// fixed-size hourly buckets over a rolling N-hour window so an
// operator can spot regressions (e.g. a slow database evening) at a
// glance, alongside the existing aggregate p50/p95 percentile numbers
// that are computed from the same job rows but without any time
// dimension.
//
// We deliberately read from `jobsTable` rather than the
// `csvIngestMetricsTable` used by `getCsvIngestMetricsSummary`
// above: the throughput card on the System page is anchored to
// `ingest_csv` jobs (the user-facing "CSV ingest" entry on the queue
// table), so the chart's series matches the percentiles it sits next
// to. The per-batch streaming-ingest table tracks a different (and
// finer-grained) data source surfaced by the separate
// "CSV ingest performance" panel further down the page.
// ──────────────────────────────────────────────────────────────────────────

export interface CsvJobThroughputBucket {
  /** ISO timestamp for the start of the UTC hour. */
  hour: string;
  /** Number of succeeded `ingest_csv` jobs that fell in the bucket. */
  sampleCount: number;
  /** Total rows processed across the bucket. */
  totalRows: number;
  /** Median per-job latency in milliseconds (0 when no samples). */
  p50LatencyMs: number;
  /** 95th-percentile per-job latency in milliseconds (0 when no samples). */
  p95LatencyMs: number;
  /** Median rows-per-second across the bucket's jobs (0 when no samples). */
  p50RowsPerSecond: number;
  /** 95th-percentile rows-per-second across the bucket's jobs. */
  p95RowsPerSecond: number;
}

export interface CsvJobThroughputHistory {
  /** Hour-aligned bucket window size, oldest → newest. */
  windowHours: number;
  /** Hourly buckets, oldest → newest. Always `windowHours` long. Empty hours
   *  carry zero counters so the chart keeps a stable X axis. */
  buckets: CsvJobThroughputBucket[];
  /** Aggregate sample count across the window (sum of `sampleCount`). */
  totalSampleCount: number;
}

/**
 * Returns hourly p50/p95 latency + rows/sec rollups for `ingest_csv`
 * jobs that completed inside the rolling `windowHours` window
 * (default 24h, capped at 7 days).
 *
 * Buckets are anchored to UTC hour boundaries so a refresh at minute
 * 30 doesn't shift the X-axis labels — the trailing bucket always
 * represents "this hour so far" and the leading bucket is exactly
 * `windowHours - 1` hours earlier.
 *
 * Empty hours render as zero-sample buckets rather than being
 * dropped, so the chart maintains a fixed `windowHours`-wide grid no
 * matter how busy the system is. The job worker writes
 * `recordsProcessed` and `durationMs` into `result` on the success
 * path (see `lib/jobs/handlers/ingest-csv.ts` and the SyncResult
 * shape returned from `csvSourceAdapter.fullSync`); rows missing
 * either field are skipped — the same defensive parse the System
 * page already does client-side for the aggregate percentile card.
 */
export async function getCsvJobThroughputHistory(args: {
  windowHours?: number;
}): Promise<CsvJobThroughputHistory> {
  const windowHours = Math.max(1, Math.min(7 * 24, args.windowHours ?? 24));
  const now = new Date();
  // Anchor buckets to UTC hour boundaries (minute 0). The trailing
  // bucket starts at the current hour; the leading bucket starts
  // `windowHours - 1` hours earlier. This keeps the grid stable
  // across refreshes within the same hour.
  const currentHourStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
    ),
  );
  const windowStart = new Date(
    currentHourStart.getTime() - (windowHours - 1) * 60 * 60 * 1000,
  );

  const rows = await db
    .select({
      result: jobsTable.result,
      completedAt: jobsTable.completedAt,
    })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.kind, "ingest_csv"),
        eq(jobsTable.status, "succeeded"),
        gte(jobsTable.completedAt, windowStart),
      ),
    );

  interface BucketAccumulator {
    latencies: number[];
    rps: number[];
    rows: number;
  }

  const accumulators = new Map<number, BucketAccumulator>();
  for (let i = 0; i < windowHours; i++) {
    const ts = windowStart.getTime() + i * 60 * 60 * 1000;
    accumulators.set(ts, { latencies: [], rps: [], rows: 0 });
  }

  for (const r of rows) {
    if (!r.completedAt) continue;
    const completed = r.completedAt instanceof Date
      ? r.completedAt
      : new Date(r.completedAt);
    const bucketTs = Date.UTC(
      completed.getUTCFullYear(),
      completed.getUTCMonth(),
      completed.getUTCDate(),
      completed.getUTCHours(),
    );
    const acc = accumulators.get(bucketTs);
    if (!acc) continue;
    const result = (r.result ?? {}) as Record<string, unknown>;
    const recordsProcessed = result["recordsProcessed"];
    const durationMs = result["durationMs"];
    if (
      typeof recordsProcessed !== "number" ||
      typeof durationMs !== "number" ||
      recordsProcessed <= 0 ||
      durationMs <= 0
    ) {
      continue;
    }
    acc.latencies.push(durationMs);
    acc.rps.push(computeRowsPerSecond(recordsProcessed, durationMs));
    acc.rows += recordsProcessed;
  }

  let totalSampleCount = 0;
  const buckets: CsvJobThroughputBucket[] = [];
  for (let i = 0; i < windowHours; i++) {
    const ts = windowStart.getTime() + i * 60 * 60 * 1000;
    const acc = accumulators.get(ts)!;
    const sampleCount = acc.latencies.length;
    totalSampleCount += sampleCount;
    buckets.push({
      hour: new Date(ts).toISOString(),
      sampleCount,
      totalRows: acc.rows,
      p50LatencyMs: percentile(acc.latencies, 0.5),
      p95LatencyMs: percentile(acc.latencies, 0.95),
      p50RowsPerSecond: percentile(acc.rps, 0.5),
      p95RowsPerSecond: percentile(acc.rps, 0.95),
    });
  }

  return { windowHours, buckets, totalSampleCount };
}

function computeRowsPerSecond(rows: number, durationMs: number): number {
  if (!Number.isFinite(rows) || !Number.isFinite(durationMs)) return 0;
  if (durationMs <= 0 || rows <= 0) return 0;
  return Math.round((rows / durationMs) * 1000);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * p)),
  );
  return sorted[idx] ?? 0;
}

function ymdUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function toIsoString(v: Date | string): string {
  return toDate(v).toISOString();
}
