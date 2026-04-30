/**
 * Google Cloud Storage raw-payload landing.
 *
 * Every collector run can write its upstream payload to GCS *before*
 * parsing — this is what lets a parser fix be re-applied to historical
 * data via the replay CLI without re-fetching the source. Writes go to:
 *
 *   gs://<bucket>/<collectorId>/<YYYY/MM/DD>/<runId>.<ext>
 *
 * The date prefix keeps the lifecycle rules simple: hot for the first 90
 * days, then nearline, then deletion at 365 days unless tagged
 * `legal_hold`. Lifecycle policy is configured at the bucket level (out
 * of band, see `references/bq-cost-controls.md`).
 *
 * Helpers no-op when GCP isn't configured.
 */

import { resolveIntelligenceConfig } from "../config.js";

interface StorageClientLike {
  bucket(name: string): {
    file(path: string): {
      save(
        data: Buffer | string,
        opts?: { contentType?: string; metadata?: unknown; resumable?: boolean },
      ): Promise<unknown>;
      download(): Promise<[Buffer]>;
      getMetadata(): Promise<[Record<string, unknown>]>;
    };
    getFiles(opts: { prefix: string }): Promise<
      [
        Array<{
          name: string;
          metadata: Record<string, unknown>;
        }>,
      ]
    >;
  };
}

let cachedStorage: StorageClientLike | null = null;
let loadFailed = false;

/**
 * Test-only seam: install (or clear) the cached GCS Storage client
 * without dynamic-importing `@google-cloud/storage`. Mirrors the
 * BigQuery seam — integration tests can swap in an in-memory fake so
 * raw-payload landing succeeds (and is observable) without hitting the
 * network. Pass `null` to reset.
 */
export function __setStorageClientForTests(
  client: StorageClientLike | null,
): void {
  cachedStorage = client;
  loadFailed = false;
}

async function getStorage(): Promise<StorageClientLike | null> {
  if (cachedStorage) return cachedStorage;
  if (loadFailed) return null;
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  try {
    const mod = (await import("@google-cloud/storage")) as unknown as {
      Storage: new (opts: { projectId: string }) => StorageClientLike;
    };
    cachedStorage = new mod.Storage({ projectId: cfg.projectId });
    return cachedStorage;
  } catch {
    loadFailed = true;
    return null;
  }
}

/**
 * Build the canonical GCS object path for a collector run.
 * Pure function — does not require GCP configuration.
 */
export function rawPayloadPath(args: {
  collectorId: string;
  runId: string;
  observedAt: Date;
  extension: string;
}): string {
  const y = args.observedAt.getUTCFullYear();
  const m = String(args.observedAt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(args.observedAt.getUTCDate()).padStart(2, "0");
  // Collector ID may contain dashes — collapse anything risky to a safe
  // segment so we never emit accidental path traversal.
  const safeCollector = args.collectorId.replace(/[^a-z0-9_-]/gi, "_");
  const safeRun = args.runId.replace(/[^a-z0-9_-]/gi, "_");
  const ext = args.extension.replace(/^\./, "").toLowerCase();
  return `${safeCollector}/${y}/${m}/${d}/${safeRun}.${ext}`;
}

/**
 * Build the full `gs://bucket/path` pointer for a raw payload, given the
 * configured bucket. Returns `null` when GCP isn't configured.
 */
export function rawPayloadPointer(path: string): string | null {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  return `gs://${cfg.gcsRawBucket}/${path}`;
}

export interface LandPayloadArgs {
  collectorId: string;
  runId: string;
  observedAt: Date;
  payload: Buffer | string;
  contentType?: string;
  /** File extension without the dot ("xml", "json", "csv"). */
  extension?: string;
  /** Free-form per-object metadata stored alongside the blob. */
  metadata?: Record<string, string>;
}

export interface LandPayloadResult {
  /** Full `gs://...` pointer suitable for `raw_payload_pointer` columns. */
  pointer: string;
  /** Object path within the bucket (no `gs://bucket/` prefix). */
  path: string;
  bytes: number;
}

/**
 * Test-only override for `landRawPayload`. Set to a fake when you want
 * the runtime to behave as if GCS landing succeeded without actually
 * standing up a Storage client. Always reset to `null` after the test
 * to avoid bleeding into other suites.
 */
let landRawPayloadOverride:
  | ((args: LandPayloadArgs) => Promise<LandPayloadResult | null>)
  | null = null;

export function __setLandRawPayloadOverrideForTests(
  override:
    | ((args: LandPayloadArgs) => Promise<LandPayloadResult | null>)
    | null,
): void {
  landRawPayloadOverride = override;
}

/**
 * Write a raw payload to GCS. Returns `null` when GCP isn't configured —
 * callers must treat that as "raw landing skipped" and proceed with the
 * legacy code path.
 */
export async function landRawPayload(
  args: LandPayloadArgs,
): Promise<LandPayloadResult | null> {
  if (landRawPayloadOverride) return landRawPayloadOverride(args);
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  const storage = await getStorage();
  if (!storage) return null;
  const ext = args.extension ?? "bin";
  const path = rawPayloadPath({
    collectorId: args.collectorId,
    runId: args.runId,
    observedAt: args.observedAt,
    extension: ext,
  });
  const file = storage.bucket(cfg.gcsRawBucket).file(path);
  const body =
    typeof args.payload === "string" ? Buffer.from(args.payload) : args.payload;
  await file.save(body, {
    contentType: args.contentType ?? "application/octet-stream",
    metadata: args.metadata ? { metadata: args.metadata } : undefined,
    resumable: false,
  });
  return {
    pointer: `gs://${cfg.gcsRawBucket}/${path}`,
    path,
    bytes: body.length,
  };
}

/**
 * List GCS payload pointers for a collector + day window. Used by the
 * replay CLI to walk historical runs without touching the upstream API.
 */
export async function listRawPayloads(args: {
  collectorId: string;
  /** Inclusive start date (UTC). */
  fromUtc: Date;
  /** Inclusive end date (UTC). */
  toUtc: Date;
}): Promise<Array<{ path: string; pointer: string }>> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return [];
  const storage = await getStorage();
  if (!storage) return [];

  const safeCollector = args.collectorId.replace(/[^a-z0-9_-]/gi, "_");
  const out: Array<{ path: string; pointer: string }> = [];

  // Walk one day at a time so we use the indexed `prefix=` filter and
  // avoid listing the entire collector tree for short windows.
  const cursor = new Date(
    Date.UTC(
      args.fromUtc.getUTCFullYear(),
      args.fromUtc.getUTCMonth(),
      args.fromUtc.getUTCDate(),
    ),
  );
  const end = new Date(
    Date.UTC(
      args.toUtc.getUTCFullYear(),
      args.toUtc.getUTCMonth(),
      args.toUtc.getUTCDate(),
    ),
  );
  while (cursor.getTime() <= end.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cursor.getUTCDate()).padStart(2, "0");
    const prefix = `${safeCollector}/${y}/${m}/${d}/`;
    const [files] = await storage
      .bucket(cfg.gcsRawBucket)
      .getFiles({ prefix });
    for (const f of files) {
      out.push({
        path: f.name,
        pointer: `gs://${cfg.gcsRawBucket}/${f.name}`,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Read a previously-landed payload back as a Buffer. */
export async function readRawPayload(path: string): Promise<Buffer | null> {
  const cfg = resolveIntelligenceConfig();
  if (!cfg) return null;
  const storage = await getStorage();
  if (!storage) return null;
  const file = storage.bucket(cfg.gcsRawBucket).file(path);
  const [buf] = await file.download();
  return buf;
}
