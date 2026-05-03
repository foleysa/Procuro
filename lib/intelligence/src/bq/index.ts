/**
 * BigQuery sidecar — lazy client + idempotent dataset/table ensure helpers
 * for the `market_signals_warehouse` dataset.
 *
 * All helpers no-op (logging, never throwing) when GCP isn't configured so
 * the platform keeps running on a workstation or in CI without GCP creds.
 *
 * The BigQuery SDK is loaded via dynamic `import()` so the package is
 * truly optional: missing module is treated as "GCP unavailable" rather
 * than a hard failure.
 */

import { resolveIntelligenceConfig, type IntelligenceConfig } from "../config.js";

export interface BigQueryClientLike {
  dataset(id: string): {
    exists(): Promise<[boolean]>;
    create(opts?: Record<string, unknown>): Promise<unknown>;
    table(id: string): {
      exists(): Promise<[boolean]>;
      create(opts?: Record<string, unknown>): Promise<unknown>;
      insert(rows: unknown, opts?: Record<string, unknown>): Promise<unknown>;
    };
  };
  query(opts: {
    query: string;
    params?: Record<string, unknown>;
    /**
     * Per-parameter type hints. Required by `@google-cloud/bigquery`
     * for ARRAY parameters and for parameters whose JS value is `null`
     * (otherwise the SDK can't infer the BigQuery type). Strings here
     * mirror the BQ standard SQL types: "STRING", "INT64", "NUMERIC",
     * "TIMESTAMP", or `[<inner>]` for arrays.
     */
    types?: Record<string, string | string[]>;
    maximumBytesBilled?: string;
    location?: string;
    /**
     * Job labels propagated to the BigQuery job metadata. Used so the
     * `INFORMATION_SCHEMA.JOBS_BY_PROJECT` view can attribute billed
     * bytes back to the originating collector — this is what makes
     * the real-cost path in the Cost tab work in production. Keys
     * must match BigQuery's label-key rules (lowercase, [-_a-z0-9]).
     */
    labels?: Record<string, string>;
  }): Promise<[unknown[]]>;
}

let cachedClient: BigQueryClientLike | null = null;
let loadFailed = false;

/**
 * Test-only seam: install (or clear) the cached BigQuery client without
 * going through the dynamic `@google-cloud/bigquery` import. Lets
 * integration tests inject a fake client that records `query()` and
 * `dataset(...).table(...).insert(...)` calls so we can assert what the
 * runtime would have sent to BigQuery without touching the network.
 *
 * Pass `null` to reset both the cached client and the "load failed"
 * memo so a follow-up test can re-install a fresh fake.
 */
export function __setBigQueryClientForTests(
  client: BigQueryClientLike | null,
): void {
  cachedClient = client;
  loadFailed = false;
}

/**
 * Lazily resolve a BigQuery client, returning `null` when:
 *   - the intelligence config isn't fully populated, or
 *   - the optional `@google-cloud/bigquery` peer isn't installed.
 *
 * The "module not installed" path is logged once and then memoised so
 * we don't re-attempt the dynamic import on every call.
 */
export async function getBigQueryClient(): Promise<BigQueryClientLike | null> {
  if (cachedClient) return cachedClient;
  if (loadFailed) return null;
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  try {
    // Dynamic import keeps the dep optional and bundlers happy. We cast
    // through `unknown` because the structural type we use here is a
    // duck-typed subset of the real `BigQuery` shape — keeping our own
    // surface lets the rest of the package compile without a runtime
    // dependency on the @google-cloud SDK types.
    const mod = (await import("@google-cloud/bigquery")) as unknown as {
      BigQuery: new (opts: { projectId: string }) => BigQueryClientLike;
    };
    cachedClient = new mod.BigQuery({ projectId: cfg.projectId });
    return cachedClient;
  } catch {
    loadFailed = true;
    return null;
  }
}

/** SQL DDL for the canonical `market_signals` bitemporal fact table. */
export const MARKET_SIGNALS_DDL = (cfg: IntelligenceConfig): string => `
CREATE TABLE IF NOT EXISTS \`${cfg.projectId}.${cfg.bqDataset}.market_signals\` (
  signal_id STRING NOT NULL,
  org_id STRING,
  collector_id STRING NOT NULL,
  signal_type STRING NOT NULL,
  scope_category_code STRING,
  scope_sku STRING,
  scope_material_code STRING,
  scope_supplier_name STRING,
  scope_lane_key STRING,
  scope_region_code STRING,
  value NUMERIC NOT NULL,
  unit STRING NOT NULL,
  currency STRING NOT NULL,
  observed_at TIMESTAMP NOT NULL,
  ingested_at TIMESTAMP NOT NULL,
  source_url STRING NOT NULL,
  source_collector_id STRING NOT NULL,
  source_run_id STRING NOT NULL,
  raw_payload_pointer STRING,
  posture_class STRING NOT NULL,
  disclosure_tier STRING NOT NULL,
  jurisdiction STRING NOT NULL,
  confidence NUMERIC NOT NULL,
  entity_uid_nullable STRING,
  stable_signal_key STRING NOT NULL,
  valid_from TIMESTAMP NOT NULL,
  valid_to TIMESTAMP,
  system_from TIMESTAMP NOT NULL,
  system_to TIMESTAMP,
  metadata JSON
)
PARTITION BY DATE(ingested_at)
CLUSTER BY signal_type, scope_material_code, collector_id
`;

export const COLLECTOR_RUNS_DDL = (cfg: IntelligenceConfig): string => `
CREATE TABLE IF NOT EXISTS \`${cfg.projectId}.${cfg.bqDataset}.collector_runs\` (
  run_id STRING NOT NULL,
  collector_id STRING NOT NULL,
  posture_class STRING NOT NULL,
  disclosure_tier STRING NOT NULL,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP,
  duration_ms INT64,
  rows_emitted INT64 NOT NULL,
  bytes_raw INT64,
  parse_errors INT64 NOT NULL,
  schema_drift_count INT64 NOT NULL,
  raw_payload_pointer STRING,
  raw_landing_failed BOOL,
  status STRING NOT NULL,
  error STRING
)
PARTITION BY DATE(started_at)
CLUSTER BY collector_id, status
`;

/**
 * Backfill ALTER for warehouses created before `raw_landing_failed`
 * was introduced. `CREATE TABLE IF NOT EXISTS` only seeds the schema
 * for *new* tables — without this ALTER an existing table would
 * silently drop the field on insert (we use `ignoreUnknownValues`),
 * defeating the operator-visibility goal of task #133.
 */
export const COLLECTOR_RUNS_RAW_LANDING_ALTER = (
  cfg: IntelligenceConfig,
): string => `
ALTER TABLE \`${cfg.projectId}.${cfg.bqDataset}.collector_runs\`
ADD COLUMN IF NOT EXISTS raw_landing_failed BOOL
`;

/**
 * Backfill ALTER for warehouses created before `scope_region_code` was
 * introduced (task #235). The new BLS OEWS wage benchmarks tag every
 * signal with a region (US-NATIONAL, state, metro) and the warehouse
 * needs the column so analysts can group/slice wage benchmarks
 * regionally. `CREATE TABLE IF NOT EXISTS` only seeds the schema for
 * *new* tables — without this ALTER an existing warehouse would
 * silently drop the field on insert (we use `ignoreUnknownValues`).
 */
export const MARKET_SIGNALS_REGION_ALTER = (
  cfg: IntelligenceConfig,
): string => `
ALTER TABLE \`${cfg.projectId}.${cfg.bqDataset}.market_signals\`
ADD COLUMN IF NOT EXISTS scope_region_code STRING
`;

export const ENTITIES_DDL = (cfg: IntelligenceConfig): string => `
CREATE TABLE IF NOT EXISTS \`${cfg.projectId}.${cfg.bqDataset}.entities\` (
  entity_uid STRING NOT NULL,
  primary_name STRING NOT NULL,
  alt_names ARRAY<STRING>,
  country STRING,
  identifiers STRUCT<
    lei STRING,
    ein STRING,
    cik STRING,
    companies_house STRING,
    uei STRING,
    ticker STRING
  >,
  confidence NUMERIC NOT NULL,
  source_collector_ids ARRAY<STRING>,
  first_seen TIMESTAMP NOT NULL,
  last_seen TIMESTAMP NOT NULL
)
CLUSTER BY country, primary_name
`;

/**
 * Idempotent dataset + table bootstrap. Safe to call on every boot.
 * Returns `false` when GCP isn't configured (no work attempted).
 */
export async function ensureWarehouseSchema(): Promise<boolean> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return false;
  const bq = await getBigQueryClient();
  if (!bq) return false;

  const dataset = bq.dataset(cfg.bqDataset);
  const [exists] = await dataset.exists();
  if (!exists) {
    await dataset.create({
      location: cfg.bqLocation,
      // Default expiration applies to *new* tables in the dataset; the
      // canonical fact table is created without an expiration so retention
      // is handled by `valid_to`/`system_to` close instead of TTL.
      defaultTableExpirationMs: cfg.defaultTableExpirationMs,
    });
  }

  // CREATE TABLE IF NOT EXISTS is itself idempotent — running these on
  // every boot is fine and keeps the schema canonical. The trailing
  // ALTER backfills `raw_landing_failed` on warehouses provisioned
  // before that column existed; `ADD COLUMN IF NOT EXISTS` is a no-op
  // when the column is already present.
  for (const ddl of [
    MARKET_SIGNALS_DDL(cfg),
    MARKET_SIGNALS_REGION_ALTER(cfg),
    COLLECTOR_RUNS_DDL(cfg),
    COLLECTOR_RUNS_RAW_LANDING_ALTER(cfg),
    ENTITIES_DDL(cfg),
  ]) {
    await bq.query({
      query: ddl,
      maximumBytesBilled: String(cfg.maxBytesBilled),
      location: cfg.bqLocation,
    });
  }
  return true;
}

/**
 * Append a parsed market-signal row to the warehouse using a MERGE so
 * re-running a collector against the same observation is a no-op against
 * BQ as well as Postgres. Supersession is implemented by closing
 * `system_to` on the prior row whose `stable_signal_key` matches and
 * which is still open (`system_to IS NULL`).
 */
export interface BqMarketSignalRow {
  signalId: string;
  orgId: string | null;
  collectorId: string;
  signalType: string;
  scopeCategoryCode: string | null;
  scopeSku: string | null;
  scopeMaterialCode: string | null;
  scopeSupplierName: string | null;
  scopeLaneKey: string | null;
  scopeRegionCode: string | null;
  value: string;
  unit: string;
  currency: string;
  observedAt: Date;
  ingestedAt: Date;
  sourceUrl: string;
  sourceCollectorId: string;
  sourceRunId: string;
  rawPayloadPointer: string | null;
  postureClass: string;
  disclosureTier: string;
  jurisdiction: string;
  confidence: string;
  entityUidNullable: string | null;
  stableSignalKey: string;
  validFrom: Date;
  validTo: Date | null;
  metadata: Record<string, unknown>;
}

/**
 * MERGE a batch of bitemporal market-signal rows into BQ.
 *
 * Idempotency strategy: `stable_signal_key` is the natural identity. When
 * the latest open row for a key has the same `value`, we skip it. When
 * the value differs, we close the prior row's `system_to` and insert a
 * new open row. Re-running on identical input is therefore a no-op.
 */
export async function mergeMarketSignals(
  rows: readonly BqMarketSignalRow[],
): Promise<{ merged: number } | null> {
  if (rows.length === 0) return { merged: 0 };
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  const bq = await getBigQueryClient();
  if (!bq) return null;

  // Encode the batch as a JSON literal that BQ can UNNEST. This avoids
  // a per-row parameter cap and keeps the MERGE a single query.
  const payload = rows.map((r) => ({
    signal_id: r.signalId,
    org_id: r.orgId,
    collector_id: r.collectorId,
    signal_type: r.signalType,
    scope_category_code: r.scopeCategoryCode,
    scope_sku: r.scopeSku,
    scope_material_code: r.scopeMaterialCode,
    scope_supplier_name: r.scopeSupplierName,
    scope_lane_key: r.scopeLaneKey,
    scope_region_code: r.scopeRegionCode,
    value: r.value,
    unit: r.unit,
    currency: r.currency,
    observed_at: r.observedAt.toISOString(),
    ingested_at: r.ingestedAt.toISOString(),
    source_url: r.sourceUrl,
    source_collector_id: r.sourceCollectorId,
    source_run_id: r.sourceRunId,
    raw_payload_pointer: r.rawPayloadPointer,
    posture_class: r.postureClass,
    disclosure_tier: r.disclosureTier,
    jurisdiction: r.jurisdiction,
    confidence: r.confidence,
    entity_uid_nullable: r.entityUidNullable,
    stable_signal_key: r.stableSignalKey,
    valid_from: r.validFrom.toISOString(),
    valid_to: r.validTo ? r.validTo.toISOString() : null,
    metadata: JSON.stringify(r.metadata),
  }));

  const fqTable = `\`${cfg.projectId}.${cfg.bqDataset}.market_signals\``;

  // Bitemporal supersession can't be expressed in a single MERGE because
  // the "value changed" case needs both an UPDATE (close prior row) AND
  // an INSERT (open the replacement row). BigQuery MERGE only fires one
  // branch per source row, so we issue two statements:
  //
  //   1. UPDATE: close every open row whose value differs from the new
  //      observation (sets system_to = incoming ingested_at).
  //   2. INSERT: write a new open row for every incoming observation
  //      that is not already represented by an *open* row with the same
  //      value.
  //
  // Both statements are deterministic and idempotent: re-running the
  // same payload yields zero updates (no value mismatch) and zero
  // inserts (every key has an open matching-value row already).
  const closeStmt = `
UPDATE ${fqTable} T
SET system_to = TIMESTAMP(S.ingested_at)
FROM UNNEST(@rows) S
WHERE T.stable_signal_key = S.stable_signal_key
  AND T.system_to IS NULL
  AND T.value != CAST(S.value AS NUMERIC)
`;

  const insertStmt = `
INSERT INTO ${fqTable} (
  signal_id, org_id, collector_id, signal_type,
  scope_category_code, scope_sku, scope_material_code,
  scope_supplier_name, scope_lane_key, scope_region_code,
  value, unit, currency,
  observed_at, ingested_at,
  source_url, source_collector_id, source_run_id, raw_payload_pointer,
  posture_class, disclosure_tier, jurisdiction,
  confidence, entity_uid_nullable, stable_signal_key,
  valid_from, valid_to, system_from, system_to, metadata
)
SELECT
  S.signal_id, S.org_id, S.collector_id, S.signal_type,
  S.scope_category_code, S.scope_sku, S.scope_material_code,
  S.scope_supplier_name, S.scope_lane_key, S.scope_region_code,
  CAST(S.value AS NUMERIC), S.unit, S.currency,
  TIMESTAMP(S.observed_at), TIMESTAMP(S.ingested_at),
  S.source_url, S.source_collector_id, S.source_run_id, S.raw_payload_pointer,
  S.posture_class, S.disclosure_tier, S.jurisdiction,
  CAST(S.confidence AS NUMERIC), S.entity_uid_nullable, S.stable_signal_key,
  TIMESTAMP(S.valid_from),
  IF(S.valid_to IS NULL, NULL, TIMESTAMP(S.valid_to)),
  TIMESTAMP(S.ingested_at), NULL,
  PARSE_JSON(S.metadata)
FROM UNNEST(@rows) S
WHERE NOT EXISTS (
  SELECT 1 FROM ${fqTable} T
  WHERE T.stable_signal_key = S.stable_signal_key
    AND T.system_to IS NULL
    AND T.value = CAST(S.value AS NUMERIC)
)
`;

  // Tag both statements with the originating collector_id so the
  // `INFORMATION_SCHEMA.JOBS_BY_PROJECT` view can attribute billed
  // bytes back to a single collector (the Cost tab's real-cost
  // path). All rows in a batch come from the same collector run, so
  // the first row's id is canonical.
  const collectorLabel = sanitizeBqLabelValue(rows[0]?.collectorId ?? "");
  const labels: Record<string, string> | undefined = collectorLabel
    ? { collector_id: collectorLabel, job_kind: "merge_market_signals" }
    : undefined;
  await bq.query({
    query: closeStmt,
    params: { rows: payload },
    maximumBytesBilled: String(cfg.maxBytesBilled),
    location: cfg.bqLocation,
    ...(labels ? { labels } : {}),
  });
  await bq.query({
    query: insertStmt,
    params: { rows: payload },
    maximumBytesBilled: String(cfg.maxBytesBilled),
    location: cfg.bqLocation,
    ...(labels ? { labels } : {}),
  });
  return { merged: rows.length };
}

/**
 * BigQuery label values must be lowercase, ≤63 chars, and contain only
 * `[a-z0-9_-]`. Collector ids today already conform, but we sanitise
 * defensively so a future id with `.` or capitals doesn't make the
 * job submission fail.
 */
function sanitizeBqLabelValue(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 63);
}

export interface CollectorRunRecord {
  runId: string;
  collectorId: string;
  postureClass: string;
  disclosureTier: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  rowsEmitted: number;
  bytesRaw: number | null;
  parseErrors: number;
  schemaDriftCount: number;
  rawPayloadPointer: string | null;
  /**
   * True when the run attempted to land at least one raw payload to
   * GCS and at least one upload failed. Surfaces the silent-replay
   * outage in the workbench Source Health tab and is the durable BQ
   * signal behind the `raw_landing_failed` audit event (task #133).
   */
  rawLandingFailed: boolean;
  status: "succeeded" | "failed" | "skipped";
  error: string | null;
}

// ---------------------------------------------------------------------------
// Cost reads — pulled from the `collector_runs` table in BigQuery (the
// row source-of-truth for what every run actually processed). We
// intentionally do NOT hit `INFORMATION_SCHEMA.JOBS_BY_PROJECT` here:
// that view has its own access requirements and a 180-day retention,
// while `collector_runs` is part of the warehouse we already own.
//
// The cost estimate is `bytes_raw * $5 / 1 TB` — the same
// straight-line approximation BigQuery itself uses for on-demand
// pricing. Callers that want a *fully* real number can post-process
// the row and add scan/storage costs from the billing API.
// ---------------------------------------------------------------------------

export interface CollectorCostRow {
  collectorId: string;
  runs: number;
  rowsWritten: number;
  bytesRaw: number;
  estimateUsd: number;
  /**
   * BigQuery query/analysis cost attributed to this collector for the
   * lookback window. Populated only when costs are sourced from the
   * GCP Billing export; `null` for the on-demand-pricing estimate.
   */
  queryUsd?: number | null;
  /**
   * Cloud Storage cost attributed to this collector for the lookback
   * window. Populated only when costs are sourced from the GCP Billing
   * export; `null` for the on-demand-pricing estimate.
   */
  storageUsd?: number | null;
}

/** Per-TB on-demand BigQuery price used for the cost estimate. */
const BQ_USD_PER_TB = 5;

interface CostCacheEntry {
  fetchedAt: number;
  rows: CollectorCostRow[];
}

const costCache = new Map<string, CostCacheEntry>();
/** Default TTL for the cost cache: 24h, matching daily billing close. */
const COST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read per-collector cost + throughput numbers from the BigQuery
 * `collector_runs` table. Returns `null` when intelligence isn't
 * configured or the BigQuery client/query fails — callers must fall
 * back to the Postgres-audit-log proxy in that case.
 *
 * The result is cached in-process for 24h per
 * `(lookbackHours, collectorIds)` key so the workbench tab doesn't
 * burn a query on every page load.
 */
export async function getCollectorCostsFromBq(args: {
  lookbackHours: number;
  collectorIds: string[];
  /** Override the cache TTL, primarily for tests. Defaults to 24h. */
  cacheTtlMs?: number;
}): Promise<CollectorCostRow[] | null> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  if (args.collectorIds.length === 0) return [];

  // Stable key — sorted ids so order doesn't bust the cache.
  const sortedIds = [...args.collectorIds].sort();
  const ttl = args.cacheTtlMs ?? COST_CACHE_TTL_MS;
  const key = `${args.lookbackHours}|${sortedIds.join(",")}`;
  const cached = costCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.rows;

  const bq = await getBigQueryClient();
  if (!bq) return null;

  try {
    const sql = `
      SELECT
        collector_id,
        COUNT(*)             AS runs,
        IFNULL(SUM(rows_emitted), 0) AS rows_written,
        IFNULL(SUM(bytes_raw), 0)    AS bytes_raw
      FROM \`${cfg.projectId}.${cfg.bqDataset}.collector_runs\`
      WHERE started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(),
                                         INTERVAL @hours HOUR)
        AND collector_id IN UNNEST(@ids)
      GROUP BY collector_id
    `;
    const [rowsRaw] = await bq.query({
      query: sql,
      params: { hours: args.lookbackHours, ids: sortedIds },
      types: { hours: "INT64", ids: ["STRING"] },
      maximumBytesBilled: String(cfg.maxBytesBilled),
      location: cfg.bqLocation,
    });
    const rows: CollectorCostRow[] = (rowsRaw as Array<Record<string, unknown>>).map(
      (r) => {
        const bytes = Number(r["bytes_raw"] ?? 0);
        const estimate = (bytes / 1e12) * BQ_USD_PER_TB;
        return {
          collectorId: String(r["collector_id"]),
          runs: Number(r["runs"] ?? 0),
          rowsWritten: Number(r["rows_written"] ?? 0),
          bytesRaw: bytes,
          estimateUsd: Number(estimate.toFixed(6)),
        };
      },
    );
    costCache.set(key, { fetchedAt: Date.now(), rows });
    return rows;
  } catch {
    return null;
  }
}

/** Test helper to wipe the cost cache between assertions. */
export function __clearCollectorCostCacheForTests(): void {
  costCache.clear();
  billingCostCache.clear();
  informationSchemaCostCache.clear();
  costTimeseriesCache.clear();
}

// ---------------------------------------------------------------------------
// Per-day cost timeseries — same `bytes_raw × $5/TB` estimate as
// `getCollectorCostsFromBq`, but bucketed by `DATE(started_at)` so the
// Cost tab can plot a sparkline / per-day breakdown per collector.
//
// Returns `null` when intelligence isn't configured or the BQ query
// fails — callers are expected to fall back to the audit-log proxy
// (the route owns that fallback).
// ---------------------------------------------------------------------------

export interface CollectorCostTimeseriesPoint {
  collectorId: string;
  /** ISO date `YYYY-MM-DD` in UTC, anchored on `started_at`. */
  day: string;
  runs: number;
  rowsWritten: number;
  bytesRaw: number;
  estimateUsd: number;
}

interface CostTimeseriesCacheEntry {
  fetchedAt: number;
  rows: CollectorCostTimeseriesPoint[];
}
const costTimeseriesCache = new Map<string, CostTimeseriesCacheEntry>();

export async function getCollectorCostsTimeseriesFromBq(args: {
  lookbackDays: number;
  collectorIds: string[];
  /** Override cache TTL, primarily for tests. Defaults to 24h. */
  cacheTtlMs?: number;
}): Promise<CollectorCostTimeseriesPoint[] | null> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  if (args.collectorIds.length === 0) return [];

  const sortedIds = [...args.collectorIds].sort();
  const ttl = args.cacheTtlMs ?? COST_CACHE_TTL_MS;
  const key = `${args.lookbackDays}|${sortedIds.join(",")}`;
  const cached = costTimeseriesCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.rows;

  const bq = await getBigQueryClient();
  if (!bq) return null;

  try {
    const sql = `
      SELECT
        collector_id,
        FORMAT_DATE('%Y-%m-%d', DATE(started_at)) AS day,
        COUNT(*)                       AS runs,
        IFNULL(SUM(rows_emitted), 0)   AS rows_written,
        IFNULL(SUM(bytes_raw), 0)      AS bytes_raw
      FROM \`${cfg.projectId}.${cfg.bqDataset}.collector_runs\`
      WHERE started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(),
                                         INTERVAL @days DAY)
        AND collector_id IN UNNEST(@ids)
      GROUP BY collector_id, day
      ORDER BY collector_id, day
    `;
    const [rowsRaw] = await bq.query({
      query: sql,
      params: { days: args.lookbackDays, ids: sortedIds },
      types: { days: "INT64", ids: ["STRING"] },
      maximumBytesBilled: String(cfg.maxBytesBilled),
      location: cfg.bqLocation,
    });
    const rows: CollectorCostTimeseriesPoint[] = (
      rowsRaw as Array<Record<string, unknown>>
    ).map((r) => {
      const bytes = Number(r["bytes_raw"] ?? 0);
      const estimate = (bytes / 1e12) * BQ_USD_PER_TB;
      // BigQuery returns DATE columns as `{ value: 'YYYY-MM-DD' }` from
      // the Node SDK; the FORMAT_DATE call above already strings it,
      // but defend against the SDK shape just in case.
      const dayCell = r["day"];
      const day =
        typeof dayCell === "string"
          ? dayCell
          : dayCell &&
              typeof dayCell === "object" &&
              "value" in (dayCell as Record<string, unknown>)
            ? String((dayCell as { value: unknown }).value)
            : "";
      return {
        collectorId: String(r["collector_id"]),
        day,
        runs: Number(r["runs"] ?? 0),
        rowsWritten: Number(r["rows_written"] ?? 0),
        bytesRaw: bytes,
        estimateUsd: Number(estimate.toFixed(6)),
      };
    });
    costTimeseriesCache.set(key, { fetchedAt: Date.now(), rows });
    return rows;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// INFORMATION_SCHEMA.JOBS_BY_PROJECT — real per-job billed bytes.
//
// Unlike `getCollectorCostsFromBq` (which derives an *estimate* from the
// `bytes_raw` we wrote to the `collector_runs` audit table), this helper
// reads BigQuery's own job history and returns the exact billed bytes
// per query job. Per-collector attribution comes from a `collector_id`
// label that `mergeMarketSignals` sets on every job it submits — jobs
// without that label are excluded so we don't double-count work that
// wasn't ours.
//
// On-demand pricing is `total_bytes_billed * $5 / 1 TB`; flat-rate
// reservations bill differently and INFORMATION_SCHEMA still reports
// `total_bytes_billed = 0` for them, in which case this helper returns
// zero cost and the operator should fall back to the Billing export.
//
// Returns `null` when:
//   - intelligence isn't configured, or
//   - the BigQuery client isn't available, or
//   - the query against INFORMATION_SCHEMA fails (eg the caller's SA
//     lacks `bigquery.jobs.listAll`).
// Callers must treat `null` as "real-cost data unavailable" and fall
// back to the bytes_raw estimate or the Postgres-audit-log proxy.
// ---------------------------------------------------------------------------

interface InformationSchemaCacheEntry {
  fetchedAt: number;
  rows: CollectorCostRow[];
}
const informationSchemaCostCache = new Map<
  string,
  InformationSchemaCacheEntry
>();
/** Daily cache — INFORMATION_SCHEMA is cheap but not free to query. */
const INFORMATION_SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCollectorCostsFromInformationSchema(args: {
  lookbackHours: number;
  collectorIds: string[];
  /** Override cache TTL, primarily for tests. Defaults to 24h. */
  cacheTtlMs?: number;
}): Promise<CollectorCostRow[] | null> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  if (args.collectorIds.length === 0) return [];

  // Sanitise to the same shape `mergeMarketSignals` writes so the join
  // below actually matches in production.
  const sortedIds = [...args.collectorIds].sort();
  const labelIds = sortedIds.map((id) => sanitizeBqLabelValue(id));
  const ttl = args.cacheTtlMs ?? INFORMATION_SCHEMA_CACHE_TTL_MS;
  const key = `${args.lookbackHours}|${sortedIds.join(",")}|${cfg.bqLocation}`;
  const cached = informationSchemaCostCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.rows;

  const bq = await getBigQueryClient();
  if (!bq) return null;

  try {
    // INFORMATION_SCHEMA is region-scoped and requires a `region-<id>`
    // dataset prefix when queried via the standard SQL surface. The
    // configured `bqLocation` (eg "US", "EU", "us-central1") drives
    // both the prefix and the `location` hint on the job itself.
    const region = cfg.bqLocation.toLowerCase();
    const sql = `
      SELECT
        (SELECT value FROM UNNEST(labels)
          WHERE key = 'collector_id') AS collector_id,
        COUNT(*)                       AS jobs,
        IFNULL(SUM(total_bytes_billed), 0) AS bytes_billed
      FROM \`${cfg.projectId}.region-${region}.INFORMATION_SCHEMA.JOBS_BY_PROJECT\`
      WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(),
                                            INTERVAL @hours HOUR)
        AND state = 'DONE'
        AND error_result IS NULL
        AND EXISTS (
          SELECT 1 FROM UNNEST(labels) l
          WHERE l.key = 'collector_id' AND l.value IN UNNEST(@labelIds)
        )
      GROUP BY collector_id
    `;
    const [rowsRaw] = await bq.query({
      query: sql,
      params: { hours: args.lookbackHours, labelIds },
      types: { hours: "INT64", labelIds: ["STRING"] },
      maximumBytesBilled: String(cfg.maxBytesBilled),
      location: cfg.bqLocation,
      // Tag the meta-query itself so it shows up under a stable label
      // and doesn't pollute per-collector attribution if someone
      // re-runs this query repeatedly.
      labels: { job_kind: "cost_information_schema_read" },
    });

    // Map sanitised label values back to the original collector ids the
    // caller asked for — otherwise an id like "BLS-Economic" would
    // come back as "bls-economic" and the workbench could not match it.
    const labelToOriginal = new Map<string, string>();
    for (const id of sortedIds) {
      labelToOriginal.set(sanitizeBqLabelValue(id), id);
    }
    const rows: CollectorCostRow[] = (
      rowsRaw as Array<Record<string, unknown>>
    ).map((r) => {
      const labelId = String(r["collector_id"] ?? "");
      const bytes = Number(r["bytes_billed"] ?? 0);
      const estimate = (bytes / 1e12) * BQ_USD_PER_TB;
      return {
        collectorId: labelToOriginal.get(labelId) ?? labelId,
        runs: Number(r["jobs"] ?? 0),
        // `rowsWritten` isn't surfaced by INFORMATION_SCHEMA — leave it
        // at zero so the UI doesn't fabricate a count. Operators who
        // need rows-written should look at the Catalog tab.
        rowsWritten: 0,
        bytesRaw: bytes,
        estimateUsd: Number(estimate.toFixed(6)),
      };
    });
    informationSchemaCostCache.set(key, { fetchedAt: Date.now(), rows });
    return rows;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Billing-backed cost reads.
//
// When the operator has stood up a Cloud Billing export to BigQuery
// (https://cloud.google.com/billing/docs/how-to/export-data-bigquery)
// and points us at the export table via `GCP_BILLING_EXPORT_TABLE`
// (full path `project.dataset.table`), we can return *real* dollars
// for BigQuery query/analysis and Cloud Storage components rather
// than the on-demand-pricing approximation.
//
// Per-collector attribution: GCP doesn't natively label individual
// query jobs by collector_id (that's a follow-up — labelling jobs at
// query time), so we attribute the project-level totals proportionally
// to each collector's `bytes_raw` share for the same lookback window.
// This is the same model finance teams use for shared-infra cost
// allocation and is dramatically closer to ground truth than the
// per-TB estimate.
//
// Falls back to `null` when the export table isn't configured or the
// query fails — callers must then fall back to the estimate path.
// ---------------------------------------------------------------------------

interface BillingCacheEntry {
  fetchedAt: number;
  rows: CollectorCostRow[];
}
const billingCostCache = new Map<string, BillingCacheEntry>();
/** Daily cache, matching billing export close cadence. */
const BILLING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read per-collector cost rows whose `queryUsd` and `storageUsd`
 * fields are sourced from the GCP Billing export, and whose
 * `estimateUsd` field is the sum of those two for convenience.
 *
 * Returns `null` when:
 *   - intelligence isn't configured (`resolveIntelligenceConfig()` is null), or
 *   - `GCP_BILLING_EXPORT_TABLE` env is unset / not in `project.dataset.table` form, or
 *   - the BigQuery client/query fails.
 *
 * Callers must treat `null` as "billing data unavailable" and fall
 * back to `getCollectorCostsFromBq` (estimate) or the Postgres proxy.
 */
export async function getCollectorCostsFromBilling(args: {
  lookbackHours: number;
  collectorIds: string[];
  cacheTtlMs?: number;
}): Promise<CollectorCostRow[] | null> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  if (args.collectorIds.length === 0) return [];

  const exportTable = process.env["GCP_BILLING_EXPORT_TABLE"]?.trim();
  if (!exportTable || exportTable.split(".").length !== 3) return null;

  const sortedIds = [...args.collectorIds].sort();
  const ttl = args.cacheTtlMs ?? BILLING_CACHE_TTL_MS;
  const key = `${args.lookbackHours}|${sortedIds.join(",")}|${exportTable}`;
  const cached = billingCostCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.rows;

  const bq = await getBigQueryClient();
  if (!bq) return null;

  try {
    // Step 1: project-level totals from the billing export, split by
    // service. We aggregate `cost + IFNULL(SUM(credits.amount), 0)` so
    // applied credits net out the way the billing UI shows them.
    const billingSql = `
      SELECT
        service.description AS service,
        SUM(cost) + IFNULL(SUM((SELECT IFNULL(SUM(c.amount), 0)
                                FROM UNNEST(credits) c)), 0) AS net_cost
      FROM \`${exportTable}\`
      WHERE project.id = @projectId
        AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(),
                                              INTERVAL @hours HOUR)
        AND service.description IN ('BigQuery', 'Cloud Storage')
      GROUP BY service
    `;
    const [billingRowsRaw] = await bq.query({
      query: billingSql,
      params: { projectId: cfg.projectId, hours: args.lookbackHours },
      types: { projectId: "STRING", hours: "INT64" },
      maximumBytesBilled: String(cfg.maxBytesBilled),
      location: cfg.bqLocation,
    });
    let projectQueryUsd = 0;
    let projectStorageUsd = 0;
    for (const r of billingRowsRaw as Array<Record<string, unknown>>) {
      const svc = String(r["service"] ?? "");
      const cost = Number(r["net_cost"] ?? 0);
      if (svc === "BigQuery") projectQueryUsd += cost;
      else if (svc === "Cloud Storage") projectStorageUsd += cost;
    }

    // Step 2: per-collector throughput so we can attribute the
    // project-level totals proportionally to each collector.
    const usage = await getCollectorCostsFromBq({
      lookbackHours: args.lookbackHours,
      collectorIds: sortedIds,
      cacheTtlMs: ttl,
    });
    if (!usage) return null;

    const totalBytes = usage.reduce((acc, r) => acc + r.bytesRaw, 0);
    const rows: CollectorCostRow[] = usage.map((u) => {
      const share = totalBytes > 0 ? u.bytesRaw / totalBytes : 0;
      const queryUsd = projectQueryUsd * share;
      const storageUsd = projectStorageUsd * share;
      return {
        collectorId: u.collectorId,
        runs: u.runs,
        rowsWritten: u.rowsWritten,
        bytesRaw: u.bytesRaw,
        queryUsd: Number(queryUsd.toFixed(6)),
        storageUsd: Number(storageUsd.toFixed(6)),
        estimateUsd: Number((queryUsd + storageUsd).toFixed(6)),
      };
    });
    billingCostCache.set(key, { fetchedAt: Date.now(), rows });
    return rows;
  } catch {
    return null;
  }
}

/**
 * Test-only override for `recordCollectorRun`. Used by tests that need
 * to assert what the runtime actually passes for fields like
 * `rawPayloadPointer` without standing up a real BigQuery client.
 * Reset to `null` after the test.
 */
let recordCollectorRunOverride:
  | ((run: CollectorRunRecord) => Promise<boolean>)
  | null = null;

export function __setRecordCollectorRunOverrideForTests(
  override: ((run: CollectorRunRecord) => Promise<boolean>) | null,
): void {
  recordCollectorRunOverride = override;
}

/** Append a row to the `collector_runs` audit table. Best-effort. */
export async function recordCollectorRun(
  run: CollectorRunRecord,
): Promise<boolean> {
  if (recordCollectorRunOverride) return recordCollectorRunOverride(run);
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return false;
  const bq = await getBigQueryClient();
  if (!bq) return false;
  const table = bq.dataset(cfg.bqDataset).table("collector_runs");
  await table.insert(
    [
      {
        run_id: run.runId,
        collector_id: run.collectorId,
        posture_class: run.postureClass,
        disclosure_tier: run.disclosureTier,
        started_at: run.startedAt.toISOString(),
        finished_at: run.finishedAt ? run.finishedAt.toISOString() : null,
        duration_ms: run.durationMs,
        rows_emitted: run.rowsEmitted,
        bytes_raw: run.bytesRaw,
        parse_errors: run.parseErrors,
        schema_drift_count: run.schemaDriftCount,
        raw_payload_pointer: run.rawPayloadPointer,
        raw_landing_failed: run.rawLandingFailed,
        status: run.status,
        error: run.error,
      },
    ],
    { ignoreUnknownValues: true },
  );
  return true;
}
