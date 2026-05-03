/**
 * Periodic scheduling for alerts background jobs.
 *
 * Three independent schedulers, each modelled on `startJobPruner`:
 *   - `startAlertsDeliveryScheduler`     (default 30s)
 *   - `startAlertsEscalationScheduler`   (default 5min)
 *   - `startOperationalSynthScheduler`   (default 15min)
 *
 * Each scheduler enqueues an internal job (orgId=NULL) at a fixed
 * cadence iff there isn't already one pending or running. The
 * advisory-lock + status-check pattern keeps multiple processes /
 * fast restart loops from double-enqueuing.
 *
 * All three are idempotent — calling start*() twice is a no-op — so
 * the boot sequence in `index.ts` can call them unconditionally.
 */

import { db, type JobKind, type JobRow } from "@workspace/db";
import { sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";

const DEFAULT_DELIVERY_INTERVAL_MS = 30 * 1000;
const DEFAULT_ESCALATION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SYNTH_INTERVAL_MS = 15 * 60 * 1000;

const ALERT_LOCK_NS = 0x414c4554; // "ALET"
const LOCK_KEY_BY_KIND: Record<string, number> = {
  deliver_alerts: 0x44454c56, // "DELV"
  escalate_alerts: 0x45534343, // "ESCC"
  synthesize_operational_alerts: 0x53594e54, // "SYNT"
};

/**
 * Enqueue a job of `kind` iff there isn't already one pending or
 * running. Mirrors `ensurePruneJobScheduled` — see queue.ts for the
 * advisory-lock rationale.
 */
async function ensureAlertJobScheduled(kind: JobKind): Promise<JobRow | null> {
  const lockKey = LOCK_KEY_BY_KIND[kind];
  if (lockKey === undefined) {
    throw new Error(`ensureAlertJobScheduled: unknown lock key for ${kind}`);
  }
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ALERT_LOCK_NS}, ${lockKey})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = ${kind} AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) return;

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, ${kind}, NULL, '{}'::jsonb, 'pending')
    `);
    inserted = true;
  });

  if (!inserted) return null;
  // We don't strictly need to return the row — callers don't read it —
  // but follow `ensurePruneJobScheduled`'s shape so future callers can.
  const r = await db.execute<JobRow>(
    sql`SELECT * FROM jobs WHERE id = ${jobId}`,
  );
  return (r.rows[0] as JobRow | undefined) ?? null;
}

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { envVar: name, value: raw, fallback },
      "Invalid env var (must be positive number); falling back to default",
    );
    return fallback;
  }
  return n;
}

interface SchedulerHandle {
  started: boolean;
  handle: ReturnType<typeof setInterval> | null;
}

const deliveryHandle: SchedulerHandle = { started: false, handle: null };
const escalationHandle: SchedulerHandle = { started: false, handle: null };
const synthHandle: SchedulerHandle = { started: false, handle: null };

function start(
  state: SchedulerHandle,
  kind: JobKind,
  intervalMs: number,
  envVarName: string,
  defaultMs: number,
): void {
  if (state.started) return;
  state.started = true;
  const ms = intervalMs > 0 ? intervalMs : envPositiveNumber(envVarName, defaultMs);

  void ensureAlertJobScheduled(kind).catch((err) => {
    logger.error(
      { err: (err as Error).message, kind },
      "Failed to enqueue initial alert scheduler job",
    );
  });
  state.handle = setInterval(() => {
    ensureAlertJobScheduled(kind).catch((err) => {
      logger.error(
        { err: (err as Error).message, kind },
        "Failed to enqueue scheduled alert job",
      );
    });
  }, ms);
}

function stop(state: SchedulerHandle): void {
  if (state.handle) clearInterval(state.handle);
  state.handle = null;
  state.started = false;
}

export function startAlertsDeliveryScheduler(intervalMs = 0): void {
  start(
    deliveryHandle,
    "deliver_alerts",
    intervalMs,
    "ALERTS_DELIVERY_INTERVAL_MS",
    DEFAULT_DELIVERY_INTERVAL_MS,
  );
}
export function stopAlertsDeliveryScheduler(): void {
  stop(deliveryHandle);
}

export function startAlertsEscalationScheduler(intervalMs = 0): void {
  start(
    escalationHandle,
    "escalate_alerts",
    intervalMs,
    "ALERTS_ESCALATION_INTERVAL_MS",
    DEFAULT_ESCALATION_INTERVAL_MS,
  );
}
export function stopAlertsEscalationScheduler(): void {
  stop(escalationHandle);
}

export function startOperationalSynthScheduler(intervalMs = 0): void {
  start(
    synthHandle,
    "synthesize_operational_alerts",
    intervalMs,
    "ALERTS_SYNTH_INTERVAL_MS",
    DEFAULT_SYNTH_INTERVAL_MS,
  );
}
export function stopOperationalSynthScheduler(): void {
  stop(synthHandle);
}
