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
  }): Promise<[unknown[]]>;
}

let cachedClient: BigQueryClientLike | null = null;
let loadFailed = false;

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
  status STRING NOT NULL,
  error STRING
)
PARTITION BY DATE(started_at)
CLUSTER BY collector_id, status
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
  // every boot is fine and keeps the schema canonical.
  for (const ddl of [
    MARKET_SIGNALS_DDL(cfg),
    COLLECTOR_RUNS_DDL(cfg),
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
  scope_supplier_name, scope_lane_key,
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
  S.scope_supplier_name, S.scope_lane_key,
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

  await bq.query({
    query: closeStmt,
    params: { rows: payload },
    maximumBytesBilled: String(cfg.maxBytesBilled),
    location: cfg.bqLocation,
  });
  await bq.query({
    query: insertStmt,
    params: { rows: payload },
    maximumBytesBilled: String(cfg.maxBytesBilled),
    location: cfg.bqLocation,
  });
  return { merged: rows.length };
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
  status: "succeeded" | "failed" | "skipped";
  error: string | null;
}

/** Append a row to the `collector_runs` audit table. Best-effort. */
export async function recordCollectorRun(
  run: CollectorRunRecord,
): Promise<boolean> {
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
        status: run.status,
        error: run.error,
      },
    ],
    { ignoreUnknownValues: true },
  );
  return true;
}
