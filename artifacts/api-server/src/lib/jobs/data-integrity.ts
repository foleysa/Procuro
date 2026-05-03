/**
 * `data_integrity_check` job handler + scheduler (Task #314).
 *
 * Runs every 15 minutes (configurable via
 * `DATA_INTEGRITY_INTERVAL_MS`). Each tick:
 *
 *   1. Executes all eleven assertions defined in
 *      `@workspace/data-integrity` against the live DB.
 *   2. Persists every result to `data_integrity_audit_log` so the
 *      trend is queryable from `/admin` (future UI).
 *   3. For every failing result, raises an
 *      `operational_data_integrity_failed` alert through the existing
 *      `createAlert` pipeline. The dedupe key is
 *      `data_integrity:<assertion>:<utc-day>` so a persistent failure
 *      bumps a single Slack alert per day rather than spamming on
 *      every tick.
 *
 * The scheduler follows the advisory-lock pattern used by the other
 * system schedulers (routing-health, defense-pack-staleness): one
 * `data_integrity_check` may be pending/running across the whole
 * cluster at any time.
 */
import {
  db,
  jobsTable,
  dataIntegrityAuditLogTable,
  type JobRow,
} from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { createAlert } from "@workspace/intelligence";
import { ALL_ASSERTIONS, runAssertions } from "@workspace/data-integrity";
import { newId } from "../ids";
import { logger } from "../logger";

const JOB_ENQUEUE_LOCK_NS = 0x4a4f4200; // "JOB\0" — same as queue.ts
const DATA_INTEGRITY_LOCK_KEY = 0x44494348; // "DICH"
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Pick org_ids to attribute alerts to. The alerts table FKs to
 * orgs(id), so we must NEVER insert an alert with an org_id that
 * doesn't exist — the insert would fail and the failure would be
 * silently swallowed by the caller's try/catch.
 *
 * Strategy:
 *   1. If the failing assertion identified affected org_ids in its
 *      `actual.affectedOrgIds` payload (the cross-surface aggregate
 *      checks always do), VALIDATE them against the orgs table and
 *      fan out one alert per surviving org. Per-tenant attribution
 *      is the right behavior anyway — the CFO of org-A doesn't care
 *      about org-B drift.
 *   2. If the assertion is org-agnostic (savings_type, stage_history,
 *      gating families), use the deterministically-oldest org row as
 *      the platform-level recipient. This is FK-safe by construction.
 *   3. If there are NO orgs at all, log loudly and skip the alert
 *      (there's no one to alert).
 */
async function resolveAlertOrgIds(
  candidateOrgIds: string[],
): Promise<string[]> {
  if (candidateOrgIds.length > 0) {
    const r = await db.execute<{ id: string }>(
      sql`SELECT id FROM orgs WHERE id = ANY(${candidateOrgIds})`,
    );
    const valid = r.rows.map((row) => row.id as string);
    if (valid.length > 0) return valid;
  }
  const platform = await db.execute<{ id: string }>(
    sql`SELECT id FROM orgs ORDER BY created_at ASC, id ASC LIMIT 1`,
  );
  const id = platform.rows[0]?.id as string | undefined;
  return id ? [id] : [];
}

function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function runDataIntegrityCheckHandler(
  job: JobRow,
): Promise<Record<string, unknown>> {
  const payloadTriggered = (job.payload as { triggeredBy?: unknown })
    ?.triggeredBy;
  const triggeredBy: "scheduled" | "post_migration" | "manual" =
    payloadTriggered === "post_migration" || payloadTriggered === "manual"
      ? payloadTriggered
      : "scheduled";

  const startedAt = Date.now();
  const results = await runAssertions(db, ALL_ASSERTIONS);
  const failed = results.filter((r) => !r.passed);

  if (results.length > 0) {
    await db.insert(dataIntegrityAuditLogTable).values(
      results.map((r) => ({
        id: newId("dia"),
        assertionName: r.name,
        family: r.family,
        passed: r.passed,
        actual: r.actual,
        expected: r.expected,
        message: r.message,
        triggeredBy,
      })),
    );
  }

  if (failed.length > 0) {
    const day = utcDayKey();
    let alertsCreated = 0;
    let alertsFailed = 0;
    for (const r of failed) {
      const candidateOrgIds = Array.isArray(
        (r.actual as { affectedOrgIds?: unknown })?.affectedOrgIds,
      )
        ? ((r.actual as { affectedOrgIds: unknown[] }).affectedOrgIds.filter(
            (x): x is string => typeof x === "string",
          ) as string[])
        : [];
      const orgIds = await resolveAlertOrgIds(candidateOrgIds);
      if (orgIds.length === 0) {
        logger.error(
          { assertion: r.name },
          "data_integrity_check: no FK-safe org_id available; skipping alert",
        );
        alertsFailed++;
        continue;
      }
      for (const orgId of orgIds) {
        try {
          await createAlert({
            orgId,
            severity: r.family === "gating" ? "critical" : "high",
            source: "operational_data_integrity_failed",
            kind: r.name,
            title: `Data integrity: ${r.name} failed`,
            summary: r.message,
            // Per-tenant dedupe so cross-org fanout doesn't collide.
            dedupeKey: `data_integrity:${r.name}:${orgId}:${day}`,
            payload: {
              family: r.family,
              actual: r.actual,
              expected: r.expected,
              triggeredBy,
            },
            actor: "system",
          });
          alertsCreated++;
        } catch (err) {
          alertsFailed++;
          logger.error(
            {
              err: (err as Error).message,
              assertion: r.name,
              orgId,
            },
            "data_integrity_check: failed to raise alert",
          );
        }
      }
    }
    logger.info(
      { alertsCreated, alertsFailed, failedAssertions: failed.length },
      "data_integrity_check: alert fanout complete",
    );
    logger.warn(
      {
        total: results.length,
        failed: failed.length,
        durationMs: Date.now() - startedAt,
        failedAssertions: failed.map((r) => r.name),
      },
      "Data integrity check FAILED",
    );
  }
  if (failed.length === 0) {
    logger.info(
      { total: results.length, durationMs: Date.now() - startedAt },
      "Data integrity check passed",
    );
  }

  return {
    total: results.length,
    failed: failed.length,
    failedAssertions: failed.map((r) => ({
      name: r.name,
      family: r.family,
      message: r.message,
    })),
    durationMs: Date.now() - startedAt,
  } satisfies Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

async function ensureDataIntegrityCheckScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${DATA_INTEGRITY_LOCK_KEY})`,
    );
    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'data_integrity_check' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) return;
    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'data_integrity_check', NULL, '{"triggeredBy":"scheduled"}'::jsonb, 'pending')
    `);
    inserted = true;
  });

  if (!inserted) return null;
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  return row ?? null;
}

let started = false;
let handle: ReturnType<typeof setInterval> | null = null;

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { envVar: name, value: raw, fallback },
      "Invalid env var for data-integrity scheduler; using fallback",
    );
    return fallback;
  }
  return n;
}

/** Idempotent: calling twice has no effect. */
export function startDataIntegrityScheduler(intervalMs?: number): void {
  if (started) return;
  started = true;
  const ms =
    intervalMs ??
    envPositiveNumber("DATA_INTEGRITY_INTERVAL_MS", DEFAULT_INTERVAL_MS);

  void ensureDataIntegrityCheckScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial data_integrity_check",
    );
  });

  handle = setInterval(() => {
    ensureDataIntegrityCheckScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled data_integrity_check",
      );
    });
  }, ms);
}

export function stopDataIntegrityScheduler(): void {
  if (handle) clearInterval(handle);
  handle = null;
  started = false;
}
