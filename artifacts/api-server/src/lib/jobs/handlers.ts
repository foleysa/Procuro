import type { JobRow } from "@workspace/db";
import { db, erpConnectionsTable, type ErpWatermarks } from "@workspace/db";
import { eq } from "drizzle-orm";

import { runAnalysisCycle } from "../ooda/cycle";
import {
  csvSourceAdapter,
  type CsvPayload,
} from "../adapters/csv-adapter";
import {
  mockErpSourceAdapter,
  type MockErpConfig,
} from "../adapters/mock-erp-adapter";
import { writeIngestPayload } from "../adapters/ingest-writer";
import { getErpConnector } from "../connectors/erp-connector";
import { decryptCredentials } from "../erp/crypto";
import { runCollector } from "../intelligence/runtime";
import { isJobCancelRequested, pruneOldJobs } from "./queue";
import { UnrecoverableJobError } from "./queue";

/**
 * Production job handlers.
 *
 * Extracted from `src/index.ts` so they can be exercised directly from
 * tests (the live registration in `index.ts` only runs when the server
 * boots, which `node --test` does not do). Every handler does the same
 * thing it has always done — call into the adapter / runtime — but it
 * also wraps known-permanent failures in `UnrecoverableJobError` so the
 * worker fails them immediately on attempt #1 instead of burning the
 * full 3-attempt + exponential-backoff retry budget on inputs that are
 * guaranteed to fail again on every retry (malformed CSV payload,
 * missing org, unknown collector ID, etc.).
 *
 * Two flavours of "permanent input error" are recognised:
 *
 *   1. Up-front validation failures we can detect before doing any
 *      work (missing orgId, payload of the wrong shape). These are
 *      thrown as `UnrecoverableJobError` directly.
 *   2. Errors that bubble out of the adapter/runtime body and look
 *      structural — a `TypeError`/`RangeError` from operating on the
 *      wrong shape, or a Postgres NOT NULL / invalid-text-representation
 *      error caused by a missing-required-field row. Those get
 *      re-thrown as `UnrecoverableJobError` via `wrapStructuralError`.
 *
 * Anything else (DB connection blips, upstream API 5xx, etc.) is left
 * untouched so the worker's existing retry-with-backoff logic still
 * applies.
 */

/**
 * Postgres SQLSTATE codes that indicate a structurally-bad payload —
 * retrying with the same input cannot possibly succeed.
 *
 * - `23502` not_null_violation: a required column was null. Caused by
 *   a row missing a required field (e.g. supplier without a name).
 * - `22P02` invalid_text_representation: a value couldn't be coerced
 *   to its column type (e.g. "abc" for a numeric column).
 * - `22001` string_data_right_truncation: a value exceeded the column's
 *   declared max length.
 * - `22008` datetime_field_overflow / `22007` invalid_datetime_format:
 *   a date/timestamp couldn't be parsed.
 */
const PERMANENT_PG_SQLSTATES = new Set([
  "23502",
  "22P02",
  "22001",
  "22007",
  "22008",
]);

function isPermanentStructuralError(err: unknown): boolean {
  if (err instanceof UnrecoverableJobError) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof RangeError) return true;
  if (err instanceof SyntaxError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && PERMANENT_PG_SQLSTATES.has(code)) return true;
  return false;
}

/**
 * If `err` looks like a permanent input error, re-throw it as
 * `UnrecoverableJobError` (preserving the original via `cause` and the
 * original message). Otherwise re-throw as-is so the worker can apply
 * its normal transient-retry policy.
 */
function wrapStructuralError(err: unknown): never {
  if (err instanceof UnrecoverableJobError) throw err;
  if (isPermanentStructuralError(err)) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UnrecoverableJobError(message, { cause: err });
  }
  throw err;
}

function requireOrgId(job: JobRow, kind: string): string {
  const orgId = job.orgId;
  if (typeof orgId !== "string" || orgId.trim() === "") {
    throw new UnrecoverableJobError(
      `${kind} requires a non-empty orgId on the job row`,
    );
  }
  return orgId;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function ingestCsvHandler(
  job: JobRow,
): Promise<Record<string, unknown>> {
  const orgId = requireOrgId(job, "ingest_csv");
  const csvRaw = job.payload?.["csv"];
  if (csvRaw !== undefined && !isPlainObject(csvRaw)) {
    throw new UnrecoverableJobError(
      "ingest_csv payload.csv must be an object when provided",
    );
  }
  const config = (csvRaw as CsvPayload | undefined) ?? {};
  try {
    const result = await csvSourceAdapter.fullSync({
      orgId,
      config,
      isCancelled: () => isJobCancelRequested(job.id),
    });
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    wrapStructuralError(err);
  }
}

export async function ingestMockErpHandler(
  job: JobRow,
): Promise<Record<string, unknown>> {
  const orgId = requireOrgId(job, "ingest_mock_erp");
  const erpRaw = job.payload?.["erp"];
  if (erpRaw !== undefined && !isPlainObject(erpRaw)) {
    throw new UnrecoverableJobError(
      "ingest_mock_erp payload.erp must be an object when provided",
    );
  }
  const config = (erpRaw as MockErpConfig | undefined) ?? { feed: [] };
  if (!Array.isArray((config as MockErpConfig).feed)) {
    throw new UnrecoverableJobError(
      "ingest_mock_erp payload.erp.feed must be an array",
    );
  }
  try {
    const result = await mockErpSourceAdapter.fullSync({
      orgId,
      config,
      isCancelled: () => isJobCancelRequested(job.id),
    });
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    wrapStructuralError(err);
  }
}

export async function runAnalysisCycleHandler(
  job: JobRow,
): Promise<Record<string, unknown>> {
  const orgId = requireOrgId(job, "run_analysis_cycle");
  const triggeredByRaw = job.payload?.["triggeredBy"];
  const triggeredBy =
    typeof triggeredByRaw === "string" && triggeredByRaw.trim() !== ""
      ? triggeredByRaw
      : "job-runner";
  try {
    const result = await runAnalysisCycle({
      orgId,
      triggeredBy,
      isCancelled: () => isJobCancelRequested(job.id),
    });
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    wrapStructuralError(err);
  }
}

export async function runCollectorHandler(
  job: JobRow,
): Promise<Record<string, unknown>> {
  const collectorIdRaw = job.payload?.["collectorId"];
  if (typeof collectorIdRaw !== "string" || collectorIdRaw.trim() === "") {
    throw new UnrecoverableJobError(
      "run_collector payload.collectorId must be a non-empty string",
    );
  }
  // `runCollector` itself already throws `UnrecoverableJobError` for
  // unknown / unimplemented collector IDs, so its failures propagate
  // through `wrapStructuralError` unchanged.
  try {
    const result = await runCollector(collectorIdRaw, {
      isCancelled: () => isJobCancelRequested(job.id),
    });
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    wrapStructuralError(err);
  }
}

export async function pruneJobsHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  const result = await pruneOldJobs();
  return result as unknown as Record<string, unknown>;
}

/**
 * Sync a single tenant ERP connection. Reads the connection row,
 * decrypts credentials, runs the registered adapter from the per-entity
 * watermark forward, hands the resulting `IngestPayload` to the shared
 * structured writer, and — only on success — advances the watermark
 * map and clears any stored last-error. Failures leave watermarks
 * untouched so the next attempt resumes from the same point.
 *
 * Job payload shape: `{ connectionId: string }`. Auth is enforced at
 * the route layer (`requireOrgAdmin`) — by the time the worker picks
 * the job up the connection's `org_id` already equals the requester.
 */
export async function syncErpConnectionHandler(
  job: JobRow,
): Promise<Record<string, unknown>> {
  const orgId = requireOrgId(job, "sync_erp_connection");
  const connectionIdRaw = job.payload?.["connectionId"];
  if (
    typeof connectionIdRaw !== "string" ||
    connectionIdRaw.trim() === ""
  ) {
    throw new UnrecoverableJobError(
      "sync_erp_connection payload.connectionId must be a non-empty string",
    );
  }

  const connRows = await db
    .select()
    .from(erpConnectionsTable)
    .where(eq(erpConnectionsTable.id, connectionIdRaw))
    .limit(1);
  const conn = connRows[0];
  if (!conn) {
    throw new UnrecoverableJobError(
      `sync_erp_connection: connection ${connectionIdRaw} not found`,
    );
  }
  if (conn.orgId !== orgId) {
    // Worker enqueue should only happen via a tenant-scoped admin
    // route, so if we ever see a cross-tenant mismatch it's a bug or
    // a tampered queue entry — fail loudly instead of silently
    // syncing the wrong tenant.
    throw new UnrecoverableJobError(
      `sync_erp_connection: connection ${connectionIdRaw} belongs to a different org`,
    );
  }
  if (conn.status === "paused") {
    return {
      skipped: true,
      reason: "connection paused",
      connectionId: conn.id,
    };
  }

  const connector = getErpConnector(conn.adapterKey);
  if (!connector) {
    throw new UnrecoverableJobError(
      `sync_erp_connection: no adapter registered for "${conn.adapterKey}"`,
    );
  }

  let credentials: unknown;
  try {
    credentials = decryptCredentials(conn.credentialsCipher);
  } catch (err) {
    throw new UnrecoverableJobError(
      `sync_erp_connection: failed to decrypt credentials for ${conn.id}`,
      { cause: err },
    );
  }

  const credsParsed = connector.credentialsSchema.safeParse(credentials);
  if (!credsParsed.success) {
    throw new UnrecoverableJobError(
      `sync_erp_connection: stored credentials for ${conn.id} fail adapter validation`,
      { cause: credsParsed.error },
    );
  }
  const settingsParsed = connector.settingsSchema.safeParse(conn.settings);
  if (!settingsParsed.success) {
    throw new UnrecoverableJobError(
      `sync_erp_connection: stored settings for ${conn.id} fail adapter validation`,
      { cause: settingsParsed.error },
    );
  }

  try {
    const fetchResult = await connector.fetchAll({
      orgId,
      connectionId: conn.id,
      credentials: credsParsed.data,
      settings: settingsParsed.data,
      watermarks: conn.watermarks,
      isCancelled: () => isJobCancelRequested(job.id),
    });
    const writeResult = await writeIngestPayload({
      orgId,
      sourceSystem: `erp_${conn.adapterKey}`,
      payload: fetchResult.payload,
      isCancelled: () => isJobCancelRequested(job.id),
    });

    // Merge so partial-entity coverage in this pass doesn't blow away
    // a still-good watermark on an entity the adapter didn't touch.
    const mergedWatermarks: ErpWatermarks = {
      ...conn.watermarks,
    };
    for (const [entity, ts] of Object.entries(fetchResult.nextWatermarks)) {
      if (typeof ts === "string" && ts.length > 0) {
        mergedWatermarks[entity] = ts;
      }
    }

    await db
      .update(erpConnectionsTable)
      .set({
        watermarks: mergedWatermarks,
        lastSyncedAt: new Date(),
        lastError: null,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(erpConnectionsTable.id, conn.id));

    return {
      connectionId: conn.id,
      adapter: conn.adapterKey,
      pagesByEntity: fetchResult.pagesByEntity,
      recordsByEntity: fetchResult.recordsByEntity,
      writer: writeResult as unknown as Record<string, unknown>,
      watermarks: mergedWatermarks,
    };
  } catch (err) {
    // Surface the failure on the connection row so the Integrations
    // UI shows the operator what went wrong without forcing them into
    // the Jobs table. Status flips to "error" but watermarks stay
    // exactly where they were so a retry resumes mid-feed.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db
        .update(erpConnectionsTable)
        .set({
          lastError: message.slice(0, 2000),
          status: "error",
          updatedAt: new Date(),
        })
        .where(eq(erpConnectionsTable.id, conn.id));
    } catch {
      // Don't mask the original error if the status update itself fails.
    }
    wrapStructuralError(err);
  }
}
