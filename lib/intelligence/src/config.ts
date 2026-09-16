/**
 * Centralised access to the BigQuery + GCS configuration the intelligence
 * foundation relies on. Every getter returns `null` (instead of throwing)
 * when the relevant env var is missing — the runtime then short-circuits
 * the GCP code path and continues with the legacy Postgres-only flow,
 * letting the platform run on a laptop or in CI without GCP credentials.
 *
 * Required env vars for the GCP-backed analytical sidecar. Prefer the
 * `INTELLIGENCE_*` names (documented in bq-cost-controls.md); the
 * unprefixed aliases remain so existing collectors keep working.
 *   - `INTELLIGENCE_GCP_PROJECT_ID` / `GCP_PROJECT_ID`
 *   - `INTELLIGENCE_BQ_DATASET` / `BQ_DATASET` (default `market_signals_warehouse`)
 *   - `INTELLIGENCE_BQ_LOCATION` / `BQ_LOCATION` (default `US`)
 *   - `INTELLIGENCE_GCS_RAW_BUCKET` / `GCS_RAW_BUCKET`
 *   - `INTELLIGENCE_BQ_MAX_BYTES_BILLED` / `BQ_MAX_BYTES_BILLED`
 *   - `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_CREDENTIALS_JSON`
 */

function envFirst(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface IntelligenceConfig {
  projectId: string;
  bqDataset: string;
  bqLocation: string;
  gcsRawBucket: string;
  /** Per-query byte cap, enforced by the BigQuery client. */
  maxBytesBilled: number;
  /** Default table expiration in ms (90 days). */
  defaultTableExpirationMs: number;
  /** When true, helpers attempt to construct GCP clients. */
  enabled: boolean;
}

const DEFAULT_DATASET = "market_signals_warehouse";
const DEFAULT_LOCATION = "US";
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB / query
const DEFAULT_TABLE_EXPIRATION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Resolve the intelligence GCP configuration from process env. Returns
 * `null` when GCP is not configured — callers must handle this and fall
 * back to the legacy code path.
 */
export function resolveIntelligenceConfig(): IntelligenceConfig | null {
  const projectId = envFirst("INTELLIGENCE_GCP_PROJECT_ID", "GCP_PROJECT_ID");
  const gcsRawBucket = envFirst(
    "INTELLIGENCE_GCS_RAW_BUCKET",
    "GCS_RAW_BUCKET",
  );
  const credsFile = process.env["GOOGLE_APPLICATION_CREDENTIALS"]?.trim();
  const credsJson = process.env["GOOGLE_CREDENTIALS_JSON"]?.trim();

  if (!projectId || !gcsRawBucket || (!credsFile && !credsJson)) {
    return null;
  }

  const bqDataset =
    envFirst("INTELLIGENCE_BQ_DATASET", "BQ_DATASET") || DEFAULT_DATASET;
  const bqLocation =
    envFirst("INTELLIGENCE_BQ_LOCATION", "BQ_LOCATION") || DEFAULT_LOCATION;
  const maxBytesEnv = Number(
    envFirst("INTELLIGENCE_BQ_MAX_BYTES_BILLED", "BQ_MAX_BYTES_BILLED") ?? "",
  );
  const maxBytesBilled =
    Number.isFinite(maxBytesEnv) && maxBytesEnv > 0
      ? Math.floor(maxBytesEnv)
      : DEFAULT_MAX_BYTES;
  const expirationEnv = Number(
    envFirst(
      "INTELLIGENCE_BQ_DEFAULT_TABLE_TTL_MS",
      "INTELLIGENCE_BQ_DEFAULT_TABLE_EXPIRATION_MS",
      "BQ_DEFAULT_TABLE_EXPIRATION_MS",
    ) ?? "",
  );
  const defaultTableExpirationMs =
    Number.isFinite(expirationEnv) && expirationEnv > 0
      ? Math.floor(expirationEnv)
      : DEFAULT_TABLE_EXPIRATION_MS;

  return {
    projectId,
    bqDataset,
    bqLocation,
    gcsRawBucket,
    maxBytesBilled,
    defaultTableExpirationMs,
    enabled: true,
  };
}

/** True when the GCP sidecar is configured and helpers may be called. */
export function isIntelligenceEnabled(): boolean {
  return resolveIntelligenceConfig() !== null;
}
