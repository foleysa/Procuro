import {
  db,
  alertsTable,
  alertEventsTable,
  contractsTable,
  erpConnectionsTable,
  erpSyncRunsTable,
  orgsTable,
  type AlertChannelRow,
  type AlertRow,
  type ErpEntityCounts,
  type ErpWatermarks,
  type JobRow,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

import { runAnalysisCycle } from "../ooda/cycle";
import { emailChannelAdapter } from "../alerts/channels";
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
import {
  ensureOrgAnalysisCycleScheduled,
  expireStaleOpportunities,
  isJobCancelRequested,
  pruneOldFunnelSnapshots,
  pruneOldJobs,
} from "./queue";
import { UnrecoverableJobError } from "./queue";
import { newId } from "../ids";
import { logger } from "../logger";
import {
  readRenewalAlertDays,
  readRenewalEmailEnabled,
} from "../contract-settings";
import { isStructuralIngestError } from "../structural-ingest-error";

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
export const PERMANENT_PG_SQLSTATES = new Set([
  "23502",
  "22P02",
  "22001",
  "22007",
  "22008",
]);

export function isPermanentStructuralError(err: unknown): boolean {
  if (err instanceof UnrecoverableJobError) return true;
  // `StructuralIngestError` and any other error tagged with the
  // `unrecoverable: true` brand are treated identically — both mean
  // "the input is malformed; retrying will fail the same way".
  if (isStructuralIngestError(err)) return true;
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
export function wrapStructuralError(err: unknown): never {
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
 * Daily housekeeping: delete `funnel_snapshots` older than the
 * configured snapshot retention window (cascading
 * `funnel_annotations`) and `funnel_snapshot_failures` older than the
 * configured failure window. The result row surfaces the per-table
 * delete counts and whether the post-prune VACUUM succeeded so
 * operators can see exactly what the run did from the System / Jobs
 * page without digging through logs.
 */
export async function pruneFunnelSnapshotsHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  const result = await pruneOldFunnelSnapshots();
  return result as unknown as Record<string, unknown>;
}

/**
 * Daily housekeeping (task #219): flip stale `proposed`
 * opportunities to `expired` so the pending-approvals queue can't
 * grow without bound. Runs across every tenant; the result row
 * surfaces TTL vs quiet-cycles expiry counts independently so
 * operators on the System / Jobs page can tell at a glance which
 * cause is dominant.
 */
export async function expireStaleOpportunitiesHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  const result = await expireStaleOpportunities();
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
    // Capture the skip in the historical run log too — operators
    // looking at the Integrations history want to see *why* a sync
    // didn't actually fetch anything (paused vs. errored vs. empty).
    const skipNow = new Date();
    try {
      await db.insert(erpSyncRunsTable).values({
        id: newId("esrun"),
        orgId,
        connectionId: conn.id,
        jobId: job.id,
        status: "skipped",
        startedAt: skipNow,
        finishedAt: skipNow,
        durationMs: 0,
        recordsByEntity: {},
        pagesByEntity: {},
        droppedByEntity: {},
        recordsProcessed: 0,
        recordsSkipped: 0,
        error: "connection paused",
      });
    } catch (auditErr) {
      // Don't fail the job because the audit insert failed — but DO
      // surface it. Silent audit drops would degrade the Integrations
      // history panel without any operator-visible signal.
      logger.warn(
        {
          err: auditErr,
          orgId,
          connectionId: conn.id,
          jobId: job.id,
          runStatus: "skipped",
        },
        "Failed to insert erp_sync_runs audit row (paused-skip)",
      );
    }
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

  const startedAt = new Date();
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

    const finishedAt = new Date();
    await db
      .update(erpConnectionsTable)
      .set({
        watermarks: mergedWatermarks,
        lastSyncedAt: finishedAt,
        lastError: null,
        status: "active",
        updatedAt: finishedAt,
      })
      .where(eq(erpConnectionsTable.id, conn.id));

    // Per-run audit log (task #144). Aggregate per-entity drop counts
    // out of the writer warnings so the UI can show "X rows dropped
    // for $entity" without re-parsing the warnings array.
    const droppedByEntity = aggregateDroppedByEntity(writeResult.warnings);
    try {
      await db.insert(erpSyncRunsTable).values({
        id: newId("esrun"),
        orgId,
        connectionId: conn.id,
        jobId: job.id,
        status: "succeeded",
        startedAt,
        finishedAt,
        durationMs: Math.max(
          0,
          finishedAt.getTime() - startedAt.getTime(),
        ),
        recordsByEntity: fetchResult.recordsByEntity as ErpEntityCounts,
        pagesByEntity: fetchResult.pagesByEntity as ErpEntityCounts,
        droppedByEntity,
        recordsProcessed: writeResult.recordsProcessed,
        recordsSkipped: writeResult.recordsSkipped ?? 0,
        error: null,
      });
    } catch (auditErr) {
      // Don't fail an otherwise-successful sync because the audit
      // insert failed — but log it so operators notice if history
      // rows stop appearing on the Integrations page.
      logger.warn(
        {
          err: auditErr,
          orgId,
          connectionId: conn.id,
          jobId: job.id,
          runStatus: "succeeded",
        },
        "Failed to insert erp_sync_runs audit row (succeeded)",
      );
    }

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
    const finishedAt = new Date();
    try {
      await db
        .update(erpConnectionsTable)
        .set({
          lastError: message.slice(0, 2000),
          status: "error",
          updatedAt: finishedAt,
        })
        .where(eq(erpConnectionsTable.id, conn.id));
    } catch {
      // Don't mask the original error if the status update itself fails.
    }
    try {
      await db.insert(erpSyncRunsTable).values({
        id: newId("esrun"),
        orgId,
        connectionId: conn.id,
        jobId: job.id,
        status: "failed",
        startedAt,
        finishedAt,
        durationMs: Math.max(
          0,
          finishedAt.getTime() - startedAt.getTime(),
        ),
        recordsByEntity: {},
        pagesByEntity: {},
        droppedByEntity: {},
        recordsProcessed: 0,
        recordsSkipped: 0,
        error: message.slice(0, 2000),
      });
    } catch (auditErr) {
      // Don't mask the original failure if the audit insert itself
      // fails — but log a warning so we notice when failure rows
      // stop appearing on the Integrations history panel.
      logger.warn(
        {
          err: auditErr,
          orgId,
          connectionId: conn.id,
          jobId: job.id,
          runStatus: "failed",
          originalError: message.slice(0, 200),
        },
        "Failed to insert erp_sync_runs audit row (failed)",
      );
    }
    wrapStructuralError(err);
  }
}

/**
 * Tally writer-emitted `IngestWarning`s by the entity name they
 * reference (the leading segment of `field`, e.g. `suppliers[3]`
 * → `suppliers`). Falls back to the warning `code` when no field
 * path is present so unknown-record-type drops still get a count.
 */
function aggregateDroppedByEntity(
  warnings: ReadonlyArray<{ field?: string; code: string }> | undefined,
): ErpEntityCounts {
  const out: ErpEntityCounts = {};
  if (!warnings) return out;
  for (const w of warnings) {
    let key = "";
    if (typeof w.field === "string" && w.field.length > 0) {
      const m = /^([a-zA-Z0-9_]+)/.exec(w.field);
      if (m) key = m[1] ?? "";
    }
    if (!key) key = w.code ?? "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Daily renewal-alert scan.
 *
 * Iterates every tenant, reads the per-tenant
 * `contractRenewalAlertDays` from `orgs.settings` (default 90), and for
 * every active contract whose `end_date - now <= threshold_days`:
 *
 *   1. Inserts an `alerts` row with
 *      `dedupeKey = renewal:${contractId}:${threshold}` and
 *      `ON CONFLICT DO NOTHING` so re-runs are no-ops.
 *   2. Appends `threshold` to `contracts.renewalAlertedThresholds` so
 *      the contract list / detail UIs can show "alerted at <X> days"
 *      without joining `alerts`.
 *   3. If the tenant has opted in via the
 *      `contractRenewalEmailEnabled` setting (default `false` — see
 *      `contract-settings.ts`) AND the contract has an `owner` field
 *      that parses as a valid email, sends a renewal-notification
 *      email directly to that address via the shared
 *      `emailChannelAdapter` (SendGrid when `SENDGRID_API_KEY` is set;
 *      simulated otherwise) and records the send as an `alert_events`
 *      row of `eventType='delivered'` with
 *      `metadata.kind='owner_notification'`. The email body includes
 *      a deep link back to `/contracts/:id` so the owner can act
 *      directly. This is independent of the tenant subscription /
 *      channel fan-out in `deliverAlertsTick` — opt-in tenants notify
 *      contract owners whether or not they've also configured an
 *      org-wide subscription, because the contract.owner is the
 *      person directly accountable for the renewal decision.
 *
 * Severity is computed from days-to-expiry:
 *   - <= 7 days  → critical
 *   - <= 30 days → warning
 *   - otherwise  → info
 *
 * Owner-email idempotency: we only attempt the send when the alert was
 * NEWLY inserted on this tick (the `RETURNING id` clause returns no
 * rows on a dedupe no-op). Combined with the alert-row dedupe
 * `(orgId, dedupeKey)`, that means each contract gets at most one
 * owner email per `(threshold, contract)` window — even if the daily
 * scheduler double-fires or an operator presses "Run now". The audit
 * trail in `alert_events` is cheap to inspect for forensic checks.
 *
 * Each tenant is processed inside its own try/catch so a single bad
 * tenant (e.g. an FK violation from a recently-deleted contract row)
 * cannot poison the whole scan — the handler logs and continues.
 * Within a tenant, an email-send failure for one contract is also
 * isolated so it cannot block the next contract's notification.
 *
 * The job is system-scoped (no `org_id` on the job row); per-tenant
 * thresholds are read inside the handler.
 */
export async function runRenewalAlertScanHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  const orgs = await db
    .select({
      id: orgsTable.id,
      name: orgsTable.name,
      settings: orgsTable.settings,
    })
    .from(orgsTable);

  let alertsInserted = 0;
  let contractsUpdated = 0;
  let orgsScanned = 0;
  let ownerEmailsSent = 0;
  let ownerEmailsSimulated = 0;
  let ownerEmailsFailed = 0;
  let ownerEmailsSkipped = 0;
  let ownerEmailsDisabled = 0;
  const orgErrors: Array<{ orgId: string; error: string }> = [];

  for (const org of orgs) {
    orgsScanned += 1;
    const threshold = readRenewalAlertDays(org.settings ?? null);
    const emailEnabled = readRenewalEmailEnabled(org.settings ?? null);
    try {
      // Pull the candidate set in one query: active contracts whose
      // end_date is within the threshold window. We join supplier name
      // for the alert title without paying a per-row roundtrip.
      // `end_date` arrives as either a `Date` or an ISO string depending
      // on the pg type parser configuration; we normalise it below
      // before calling `toISOString()`.
      const candidates = await db.execute<{
        id: string;
        contract_number: string;
        title: string;
        supplier_id: string;
        supplier_name: string;
        owner: string | null;
        end_date: Date | string;
        days_to_expiry: number;
        already_alerted: boolean;
      }>(sql`
        SELECT c.id,
               c.contract_number,
               c.title,
               c.supplier_id,
               s.name AS supplier_name,
               c.owner,
               c.end_date,
               CEIL(EXTRACT(EPOCH FROM (c.end_date - NOW())) / 86400.0)::int
                 AS days_to_expiry,
               (${threshold} = ANY(c.renewal_alerted_thresholds))
                 AS already_alerted
        FROM contracts c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.org_id = ${org.id}
          AND c.status = 'active'
          AND c.end_date > NOW()
          AND c.end_date <= NOW() + (${threshold} || ' days')::interval
      `);

      for (const r of candidates.rows) {
        const days = Number(r.days_to_expiry);
        // Map renewal-window urgency onto the #117 alerts severity enum
        // (info|low|medium|high|critical). The original #118 worker used
        // a 3-level enum (info|warning|critical) that no longer exists
        // post-rebase; "warning" maps to "high".
        const severity =
          days <= 7 ? "critical" : days <= 30 ? "high" : "info";
        const dedupeKey = `renewal:${r.id}:${threshold}`;
        const endDateIso = (
          r.end_date instanceof Date ? r.end_date : new Date(r.end_date)
        ).toISOString();
        const alertId = newId("alt");
        const title = `Contract ${r.contract_number} renewing in ${days} day${days === 1 ? "" : "s"}`;
        const summary = `${r.title} (${r.supplier_name}) — end date ${endDateIso.slice(0, 10)}.`;

        // INSERT ... ON CONFLICT (alerts_dedupe_uq) DO NOTHING. The
        // unique index lives on `(org_id, dedupe_key)` (#117 schema),
        // so the same trigger condition can never produce two rows
        // even if the daily scheduler fires twice. Schema columns:
        // `summary` replaces `body`, `payload` replaces `metadata`,
        // and `contract_id` is a direct FK in place of the
        // `ref_type`/`ref_id` pair.
        const inserted = await db.execute<{ id: string }>(sql`
          INSERT INTO alerts (id, org_id, source, kind, severity, title,
                              summary, contract_id, supplier_id,
                              dedupe_key, payload)
          VALUES (
            ${alertId},
            ${org.id},
            'rule_match',
            'contract_renewal',
            ${severity},
            ${title},
            ${summary},
            ${r.id},
            ${r.supplier_id},
            ${dedupeKey},
            ${sql`${JSON.stringify({
              contractId: r.id,
              supplierId: r.supplier_id,
              thresholdDays: threshold,
              daysToExpiry: days,
              endDate: endDateIso,
            })}::jsonb`}
          )
          ON CONFLICT (org_id, dedupe_key) DO NOTHING
          RETURNING id
        `);
        const insertedAlertId = inserted.rows[0]?.id;
        if (insertedAlertId) {
          alertsInserted += 1;
        }

        // Even if the alert was a dedupe no-op, make sure the
        // contract column reflects the threshold so the UI badge
        // ("alerted at 90 days") matches the alerts table.
        if (!r.already_alerted) {
          await db
            .update(contractsTable)
            .set({
              renewalAlertedThresholds: sql`array_append(
                renewal_alerted_thresholds, ${threshold}
              )`,
            })
            .where(
              and(
                eq(contractsTable.orgId, org.id),
                eq(contractsTable.id, r.id),
              ),
            );
          contractsUpdated += 1;
        }

        // Owner email notification — fires only when:
        //   - The tenant has opted in via `contractRenewalEmailEnabled`
        //     (default `false`, see `contract-settings.ts`), AND
        //   - The alert was newly inserted on this tick
        //     (`insertedAlertId !== undefined`). A dedupe no-op means
        //     we already attempted notification on a previous run, so
        //     re-sending would spam the owner.
        // Tenants that haven't opted in are tallied under
        // `ownerEmailsDisabled` so the System / Jobs page can show
        // "we found a renewal we WOULD have emailed an owner about —
        // turn this on in Settings to start notifying them". To keep
        // that metric honest we only count contracts whose owner is
        // a deliverable email; null/free-form owners would have been
        // skipped anyway and shouldn't inflate the "you're missing
        // notifications" nudge.
        if (insertedAlertId) {
          if (!emailEnabled) {
            const ownerEmail = (r.owner ?? "").trim();
            if (ownerEmail && RENEWAL_OWNER_EMAIL_RE.test(ownerEmail)) {
              ownerEmailsDisabled += 1;
            }
          } else {
            const outcome = await maybeSendRenewalOwnerEmail({
              ownerRaw: r.owner,
              alertRow: {
                id: insertedAlertId,
                orgId: org.id,
                severity,
                source: "rule_match",
                kind: "contract_renewal",
                title,
                summary,
                firstSeen: new Date(),
                occurrences: 1,
              },
              orgName: org.name,
              contractId: r.id,
              contractNumber: r.contract_number,
              contractTitle: r.title,
              supplierName: r.supplier_name,
              endDateIso,
              daysToExpiry: days,
              thresholdDays: threshold,
            });
            if (outcome === "sent") ownerEmailsSent += 1;
            else if (outcome === "simulated") ownerEmailsSimulated += 1;
            else if (outcome === "failed") ownerEmailsFailed += 1;
            else ownerEmailsSkipped += 1;
          }
        }
      }
    } catch (err) {
      // One tenant's failure must not poison the whole scan — record
      // it in the result payload so the System / Jobs page can
      // surface partial-failure detail without us throwing.
      orgErrors.push({
        orgId: org.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    orgsScanned,
    alertsInserted,
    contractsUpdated,
    ownerEmailsSent,
    ownerEmailsSimulated,
    ownerEmailsFailed,
    ownerEmailsSkipped,
    ownerEmailsDisabled,
    orgErrors,
  };
}

/**
 * Resolve a deep-link URL back into the command-center for an entity
 * path like `/contracts/abc123`. Used in renewal owner emails so the
 * owner can click straight through to the contract detail page.
 *
 * Resolution order:
 *   1. Explicit `APP_BASE_URL` env (operator-set canonical URL).
 *   2. First entry of `REPLIT_DOMAINS` (Replit's published domain
 *      list — comma-separated). On a published Procuro deployment this
 *      is the production hostname, so we get a real clickable link in
 *      the email without any extra config.
 *   3. Fallback to the relative path. Most email clients won't render
 *      that as clickable, but it's still informative and avoids
 *      shipping `localhost`-style URLs into a real inbox.
 */
export function buildAppDeepLink(path: string): string {
  const explicit = process.env["APP_BASE_URL"];
  if (typeof explicit === "string" && explicit.length > 0) {
    return joinBaseAndPath(explicit, path);
  }
  const replitDomains = process.env["REPLIT_DOMAINS"];
  if (typeof replitDomains === "string" && replitDomains.length > 0) {
    const first = replitDomains.split(",")[0]?.trim();
    if (first && first.length > 0) {
      return joinBaseAndPath(`https://${first}`, path);
    }
  }
  // Relative fallback. Ensure a leading slash so callers that pass
  // "contracts/x" still produce a routable path rather than something
  // that looks like a relative file.
  return path.startsWith("/") ? path : `/${path}`;
}

function joinBaseAndPath(base: string, path: string): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${normalisedPath}`;
}

/**
 * Owner-email validation. Mirrors the regex used by the
 * `emailChannelAdapter` so a string that passes here is guaranteed to
 * pass the adapter's own `validateConfig`. Reject anything that looks
 * like a free-form name ("Bob Smith") so we don't ship to a
 * non-deliverable address.
 */
const RENEWAL_OWNER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface OwnerEmailContext {
  ownerRaw: string | null;
  alertRow: {
    id: string;
    orgId: string;
    severity: "info" | "low" | "medium" | "high" | "critical";
    source: "rule_match";
    kind: "contract_renewal";
    title: string;
    summary: string;
    firstSeen: Date;
    occurrences: number;
  };
  orgName: string;
  contractId: string;
  contractNumber: string;
  contractTitle: string;
  supplierName: string;
  endDateIso: string;
  daysToExpiry: number;
  thresholdDays: number;
}

type OwnerEmailOutcome = "sent" | "simulated" | "failed" | "skipped";

/**
 * Attempt to deliver a renewal email to the contract owner. Returns
 * `"skipped"` (with no events row) if the contract has no owner or
 * the owner string isn't a valid email.
 *
 * On any other outcome (including `"failed"`) we always append an
 * `alert_events` row so operators can see in the alert detail drawer
 * that we tried to notify the owner — and what happened.
 *
 * Errors thrown by the adapter are caught and surfaced as
 * `eventType='delivery_failed'` so the rest of the scan keeps moving;
 * the handler-level try/catch is reserved for unrecoverable per-tenant
 * faults.
 */
async function maybeSendRenewalOwnerEmail(
  ctx: OwnerEmailContext,
): Promise<OwnerEmailOutcome> {
  const ownerEmail = (ctx.ownerRaw ?? "").trim();
  if (!ownerEmail || !RENEWAL_OWNER_EMAIL_RE.test(ownerEmail)) {
    return "skipped";
  }

  // Synthesise a minimal `AlertChannelRow` so we can reuse the shared
  // adapter without persisting an `alert_channels` row per owner. The
  // adapter only reads `channel.config` and `channel.kind`; the rest
  // of the row is ignored.
  const syntheticChannel = {
    id: `inline-owner-${ctx.alertRow.id}`,
    orgId: ctx.alertRow.orgId,
    kind: "email" as const,
    name: "contract owner (inline)",
    config: { to: [ownerEmail] } as Record<string, unknown>,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AlertChannelRow;

  // Enrich the summary the adapter renders into the email body with
  // a renewal-specific blurb and a clickable deep link back into the
  // contract detail page. We do NOT mutate the persisted
  // `alerts.summary` — only the in-memory copy we hand the adapter —
  // so the in-app alert detail drawer stays terse while the email
  // gets the action-oriented wording its recipient needs.
  const deepLink = buildAppDeepLink(`/contracts/${ctx.contractId}`);
  const emailSummaryLines = [
    ctx.alertRow.summary,
    "",
    `Contract:    ${ctx.contractNumber} — ${ctx.contractTitle}`,
    `Supplier:    ${ctx.supplierName}`,
    `Days left:   ${ctx.daysToExpiry} (within the ${ctx.thresholdDays}-day renewal window)`,
    `Owner:       ${ownerEmail}`,
    "",
    `Open contract: ${deepLink}`,
  ];
  const emailSummary = emailSummaryLines.join("\n");

  // Build a minimal `AlertRow` for the adapter. The adapter only reads
  // a small surface (severity/title/summary/source/state/firstSeenAt/
  // lastSeenAt/occurrences/id) so we don't need to round-trip via a
  // full SELECT.
  const adapterAlert = {
    id: ctx.alertRow.id,
    orgId: ctx.alertRow.orgId,
    severity: ctx.alertRow.severity,
    source: ctx.alertRow.source,
    kind: ctx.alertRow.kind,
    title: ctx.alertRow.title,
    summary: emailSummary,
    state: "open",
    firstSeenAt: ctx.alertRow.firstSeen,
    lastSeenAt: ctx.alertRow.firstSeen,
    occurrences: ctx.alertRow.occurrences,
  } as unknown as AlertRow;

  let outcomeStatus: "delivered" | "failed" | "simulated" | "skipped";
  let providerMessageId: string | undefined;
  let httpStatus: number | undefined;
  let lastError: string | null = null;

  try {
    const result = await emailChannelAdapter.send({
      alert: adapterAlert,
      channel: syntheticChannel,
    });
    outcomeStatus = result.status;
    providerMessageId = result.providerMessageId;
    httpStatus = result.httpStatus;
    if (result.status === "failed") lastError = result.error ?? "unknown";
  } catch (err) {
    outcomeStatus = "failed";
    lastError = err instanceof Error ? err.message : String(err);
  }

  // Audit row — same `eventType` taxonomy used by `deliverAlertsTick`
  // so the alert detail drawer renders this side-channel send the same
  // way it renders subscription-driven sends. The `metadata.kind`
  // discriminator lets future code distinguish the two paths.
  const eventType =
    outcomeStatus === "failed" ? "delivery_failed" : "delivered";
  await db.insert(alertEventsTable).values({
    id: newId("ae"),
    alertId: ctx.alertRow.id,
    eventType,
    actor: null,
    note:
      outcomeStatus === "failed"
        ? (lastError ?? "owner email delivery failed")
        : null,
    metadata: {
      kind: "owner_notification",
      channelKind: "email",
      ownerEmail,
      orgName: ctx.orgName,
      contractId: ctx.contractId,
      contractNumber: ctx.contractNumber,
      contractTitle: ctx.contractTitle,
      supplierName: ctx.supplierName,
      endDate: ctx.endDateIso,
      daysToExpiry: ctx.daysToExpiry,
      thresholdDays: ctx.thresholdDays,
      deepLink,
      status: outcomeStatus,
      providerMessageId: providerMessageId ?? null,
      httpStatus: httpStatus ?? null,
    },
  });

  if (outcomeStatus === "delivered") return "sent";
  if (outcomeStatus === "simulated") return "simulated";
  if (outcomeStatus === "failed") {
    logger.warn(
      {
        alertId: ctx.alertRow.id,
        ownerEmail,
        error: lastError,
      },
      "Renewal owner email delivery failed",
    );
    return "failed";
  }
  return "skipped";
}

/**
 * System-scoped fan-out for the periodic OODA analysis-cycle scheduler.
 *
 * The `run_analysis_cycle` handler is per-tenant, so on each scheduler
 * tick this fan-out enqueues one `run_analysis_cycle` job per org —
 * keeping every tenant's run individually visible/retryable on the
 * System / Jobs page.
 *
 * Per-tenant dedupe: if a tenant already has a pending or running
 * cycle (whether from the previous tick or an operator pressing
 * "Run now"), we skip them this tick rather than queueing a duplicate.
 *
 * One tenant's failure (e.g. quota exceeded) never poisons the whole
 * fan-out — it gets recorded in `orgErrors` and the loop continues.
 */
export async function runAnalysisCycleFanoutHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  const orgs = await db.select({ id: orgsTable.id }).from(orgsTable);

  let orgsScanned = 0;
  let cyclesEnqueued = 0;
  let cyclesSkipped = 0;
  const enqueuedJobIds: string[] = [];
  const orgErrors: Array<{ orgId: string; error: string }> = [];

  for (const org of orgs) {
    orgsScanned += 1;
    try {
      // Atomic per-org dedupe + enqueue: the helper performs the
      // in-flight check, the quota check, and the INSERT under the
      // same per-org advisory lock that `enqueueJob` itself uses, so
      // a concurrent "Run now" click cannot slip a duplicate cycle in
      // between our SELECT and our INSERT.
      const result = await ensureOrgAnalysisCycleScheduled(org.id);
      if (result.enqueued) {
        cyclesEnqueued += 1;
        enqueuedJobIds.push(result.job.id);
      } else if (result.reason === "in_flight") {
        // Already a pending/running cycle (previous tick still working
        // or operator just kicked one off) — skip silently this tick.
        cyclesSkipped += 1;
      } else {
        // quota_exceeded — record so operators see why a tenant got
        // skipped, but keep the loop going for the rest of the orgs.
        orgErrors.push({ orgId: org.id, error: "quota_exceeded" });
      }
    } catch (err) {
      // Transient DB blip etc. — record and keep going so other
      // tenants still get their cycle.
      orgErrors.push({
        orgId: org.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    orgsScanned,
    cyclesEnqueued,
    cyclesSkipped,
    enqueuedJobIds,
    orgErrors,
  };
}

export async function deliverAlertsHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  // Lazy import: keeps this file from owning a hard dep on the alerts
  // module so `node --test` test files importing handlers don't drag
  // in alert delivery code paths they don't care about.
  const { deliverAlertsTick } = await import("../alerts/delivery");
  const result = await deliverAlertsTick();
  return result as unknown as Record<string, unknown>;
}

export async function escalateAlertsHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  const { escalateAlertsTick } = await import("../alerts/delivery");
  const result = await escalateAlertsTick();
  return result as unknown as Record<string, unknown>;
}

export async function synthesizeOperationalAlertsHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  const { synthesizeOperationalAlerts } = await import("../alerts/synthesize");
  const result = await synthesizeOperationalAlerts();
  return result as unknown as Record<string, unknown>;
}

/**
 * Routing health check (task #213).
 *
 * Compares the `category_bands ⋈ lever_bands` truth table against the
 * `v_category_lever_mappings` materialized view; the helper itself
 * runs a refresh-and-recount on first miss so transient staleness from
 * concurrent writes self-heals. Only after BOTH counts still disagree
 * does the helper return `ok = false`, at which point we throw so the
 * job lands in `failed` and `synthesize_operational_alerts` raises the
 * resulting `operational_job_failed` alert on its next tick — matching
 * the snapshot-failure-style alerting the spec calls for.
 *
 * The thrown error is `UnrecoverableJobError` so the queue's retry
 * loop short-circuits to a permanent failure (see the comment on
 * `MAX_ATTEMPTS_BY_KIND.routing_health_check` for why we don't want
 * automatic retries here).
 */
export async function runRoutingHealthCheckHandler(
  _job: JobRow,
): Promise<Record<string, unknown>> {
  const { checkRoutingHealth } = await import("../intelligence/routing");
  // Scheduled health-check semantics: always REFRESH first, then
  // row-level diff. Refreshing up front absorbs `confidence_weight`
  // UPDATEs (which the row-trigger does not see — triggers only fire
  // on truth-table writes, and even there we want a periodic safety
  // net for any cluster that loses a trigger fire). After the
  // refresh, any remaining drift is a true desync that must surface
  // as an alert, so we skip the per-call autoRefreshOnDrift retry.
  const report = await checkRoutingHealth({
    refreshFirst: true,
    autoRefreshOnDrift: false,
  });
  if (!report.ok) {
    throw new UnrecoverableJobError(
      `Routing materialized view drift unrecoverable: expected=${report.expectedRowCount}, view=${report.viewRowCount}, drift=${report.drift}`,
    );
  }
  return report as unknown as Record<string, unknown>;
}
