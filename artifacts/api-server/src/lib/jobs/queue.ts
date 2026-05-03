import {
  db,
  appSettingsTable,
  APP_SETTING_KEY_JOB_PRUNE_SCHEDULE,
  APP_SETTING_KEY_FUNNEL_SNAPSHOT_RETENTION,
  decisionsTable,
  erpConnectionsTable,
  jobsTable,
  jobKindSettingsTable,
  orgsTable,
  type AppSettingRow,
  type JobKind,
  type JobRow,
} from "@workspace/db";
import { eq, and, asc, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { newId } from "../ids";
import { logger } from "../logger";

export type JobHandler = (job: JobRow) => Promise<Record<string, unknown>>;

const handlers = new Map<JobKind, JobHandler>();

/** Maximum number of pending+running jobs a single org may have at once. */
const MAX_PENDING_JOBS_PER_ORG = 5;

/**
 * Default per-kind retry budget. A fresh enqueue counts as attempt #1, so a
 * value of 3 means "try at most 3 times total" (the original run + 2
 * automatic retries). Operators can still hit the manual "Retry" button on
 * the System / Jobs page after a job has exhausted its automatic budget,
 * which enqueues a brand-new job with a fresh attempts counter.
 *
 * Collector runs get a slightly larger budget because their dominant failure
 * mode is upstream rate-limiting / 5xx blips that almost always recover on
 * the next attempt.
 */
export const MAX_ATTEMPTS_BY_KIND: Record<JobKind, number> = {
  ingest_csv: 3,
  ingest_mock_erp: 3,
  run_analysis_cycle: 3,
  run_collector: 5,
  // Live ERP syncs hit upstream OAuth-gated REST APIs (Coupa, etc.)
  // whose dominant failure mode is the same transient 429/5xx blip the
  // collectors face, so they get the same slightly larger budget.
  sync_erp_connection: 5,
  // The pruner is internal housekeeping with no upstream API calls; if a
  // single run trips on a transient DB hiccup it's fine to retry once or
  // twice, but the next scheduled run will catch up regardless, so the
  // default budget of 3 is plenty.
  prune_jobs: 3,
  // Funnel-snapshot pruner — same shape as `prune_jobs` (internal DB
  // housekeeping, no upstream calls), so it gets the same default
  // retry budget for the same reasons.
  prune_funnel_snapshots: 3,
  // Funnel-snapshot backfill (task #195). Walks every completed
  // cycle for one tenant (or every tenant) and re-emits the
  // snapshot. Pure DB work, no upstream API calls — same retry
  // budget as the other system pruners. The work is idempotent
  // (existing snapshots are skipped) so a retry after a transient
  // DB blip simply resumes the scan.
  backfill_funnel_snapshots: 3,
  // Daily renewal-alert scan does only DB work (no upstream API calls);
  // a transient retry budget of 3 mirrors the pruner.
  renewal_alert_scan: 3,
  // System-scoped fan-out that enqueues a `run_analysis_cycle` job per
  // tenant on each scheduler tick. Pure DB work — same retry budget as
  // the renewal scan.
  analysis_cycle_fanout: 3,
  // Alert delivery talks to upstream channels (SMTP/HTTP) which are flaky;
  // give it a slightly larger budget so a single rate-limit / 5xx blip
  // doesn't drop a notification on the floor.
  deliver_alerts: 5,
  // Escalation walks the open alerts table and re-fans-out to channels;
  // a transient DB hiccup is the only realistic failure mode.
  escalate_alerts: 3,
  // Synthesizer is internal — same reasoning as the pruner.
  synthesize_operational_alerts: 3,
  // Auto-expire of stale `proposed` opportunities is internal DB
  // housekeeping with no upstream API calls; same retry budget as
  // the other pruners.
  expire_stale_opportunities: 3,
  // Hourly snooze-clear is internal DB housekeeping (no upstream
  // calls); same retry budget as the other system pruners. The
  // sweep is naturally idempotent — once a row's snoozed_until has
  // been cleared, the WHERE clause stops matching it.
  clear_expired_snoozes: 3,
  // Routing materialized-view drift check is intentionally NOT retried:
  // the handler's own refresh-and-recount step already absorbs transient
  // staleness. If a run still ends with `ok=false` we want the failed
  // job row visible immediately so `synthesize_operational_alerts`
  // raises `operational_job_failed` on the next tick instead of waiting
  // for the retry budget to drain.
  routing_health_check: 1,
  // Defense Pack staleness scan is internal DB work (no upstream
  // calls); same retry budget as the other system pruners.
  defense_pack_staleness_scan: 3,
  // Data integrity assertions (task #314). Pure DB work, no upstream
  // calls; we deliberately keep the retry budget tight (1) so a
  // genuinely failing assertion surfaces on the next 15-minute tick
  // rather than getting hidden by a retry-and-recover loop.
  data_integrity_check: 1,
};

/** Hard upper bound to keep pathological values out of the DB. */
export const MAX_ATTEMPTS_LIMIT = 100;

/**
 * Resolve the effective retry budget for a job kind, scoped to a single
 * tenant: returns the operator override from `job_kind_settings` for
 * `(orgId, kind)` if one is set, otherwise the in-code default from
 * `MAX_ATTEMPTS_BY_KIND`. Defaults to 3 if neither is available
 * (defensive — every known kind has an entry above).
 *
 * `orgId` is required for a per-tenant lookup. System/internal jobs that
 * have no tenant scope (e.g. `prune_jobs` with `orgId === null`) should
 * skip this helper or pass `null`, in which case only the in-code
 * default is consulted — there is no global override layer.
 */
export async function resolveMaxAttempts(
  kind: JobKind,
  orgId: string | null,
): Promise<number> {
  if (orgId) {
    const [row] = await db
      .select({ maxAttempts: jobKindSettingsTable.maxAttempts })
      .from(jobKindSettingsTable)
      .where(
        and(
          eq(jobKindSettingsTable.orgId, orgId),
          eq(jobKindSettingsTable.kind, kind),
        ),
      );
    if (row && Number.isFinite(row.maxAttempts) && row.maxAttempts > 0) {
      return row.maxAttempts;
    }
  }
  return MAX_ATTEMPTS_BY_KIND[kind] ?? 3;
}

/** Backoff: 5s base, doubles each attempt, capped at 5 minutes, ±25% jitter. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 5 * 60 * 1_000;

/**
 * Returns the backoff delay in milliseconds for the given attempt count.
 * `attempt` is the number of attempts ALREADY made (>= 1). The first retry
 * (after attempt #1 failed) waits ~5s, the second ~10s, the third ~20s,
 * and so on, capped at five minutes. A small jitter prevents synchronized
 * thundering-herd retries when many jobs fail at the same instant (e.g. a
 * shared upstream API blip).
 */
export function nextBackoffMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  const jitter = Math.random() * 0.25 * base;
  return Math.floor(base + jitter);
}

/**
 * Marker error class for failures that are known to be permanent and
 * therefore should NOT consume retry budget. Throw this from a job handler
 * (or wrap the underlying error) when the input is structurally invalid,
 * a referenced entity does not exist, or any other condition where retrying
 * the same payload is guaranteed to fail again.
 */
export class UnrecoverableJobError extends Error {
  readonly unrecoverable = true as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnrecoverableJobError";
  }
}

function isUnrecoverable(err: unknown): boolean {
  return (
    err instanceof UnrecoverableJobError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { unrecoverable?: unknown }).unrecoverable === true)
  );
}

/**
 * Namespace integer for per-org advisory locks used during job enqueue.
 * Chosen to avoid collision with other app-level advisory locks.
 */
const JOB_ENQUEUE_LOCK_NS = 0x4a4f4200; // "JOB\0"

export function registerJobHandler(kind: JobKind, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export class JobQuotaExceededError extends Error {
  readonly statusCode = 429;
  constructor(orgId: string) {
    super(
      `Job queue quota exceeded for org ${orgId}: at most ${MAX_PENDING_JOBS_PER_ORG} pending/running jobs are allowed at a time.`,
    );
    this.name = "JobQuotaExceededError";
  }
}

/**
 * Stable 32-bit signed integer hash of a string, used as a PostgreSQL
 * advisory lock sub-key. Collisions are possible but benign — two orgs
 * that hash to the same key will serialize against each other, never
 * against unrelated orgs.
 */
function stringHash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

export async function enqueueJob(args: {
  kind: JobKind;
  orgId?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Override the per-kind default retry budget. Mostly useful for tests
   * and one-off internal jobs; production callers should rely on the
   * defaults so behaviour stays consistent across the queue.
   */
  maxAttempts?: number;
}): Promise<JobRow> {
  const orgId = args.orgId ?? null;
  const jobId = newId("job");
  const kind = args.kind;
  const payload = args.payload ?? {};
  // If the caller provided an explicit override (mostly tests / one-off
  // internal jobs) honour it; otherwise consult `job_kind_settings` for a
  // per-tenant operator override and fall back to the in-code default.
  // Note: `resolveMaxAttempts` returns the in-code default when `orgId`
  // is null, since per-tenant overrides only exist for tenant-scoped
  // jobs (system jobs like `prune_jobs` always use the default).
  const resolved =
    args.maxAttempts !== undefined
      ? args.maxAttempts
      : await resolveMaxAttempts(kind, orgId);
  const maxAttempts = Math.max(1, Math.floor(resolved));

  if (orgId) {
    // Acquire a transaction-scoped advisory lock keyed to this org before
    // checking the quota and inserting. pg_advisory_xact_lock serializes
    // concurrent enqueue requests for the same org so the COUNT check and
    // INSERT are effectively atomic — no concurrent request for the same org
    // can sneak in between them.
    const lockKey = stringHash32(orgId);
    let inserted = false;

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${lockKey})`,
      );

      const countResult = await tx.execute(sql`
        SELECT COUNT(*) AS cnt FROM jobs
        WHERE org_id = ${orgId} AND status IN ('pending', 'running')
      `);
      const rows = (countResult.rows ?? []) as Array<Record<string, unknown>>;
      const current = Number(rows[0]?.cnt ?? 0);
      if (current >= MAX_PENDING_JOBS_PER_ORG) {
        return; // inserted stays false; advisory lock released on tx end
      }

      await tx.execute(sql`
        INSERT INTO jobs (id, kind, org_id, payload, status, max_attempts)
        VALUES (${jobId}, ${kind}, ${orgId}, ${JSON.stringify(payload)}::jsonb, 'pending', ${maxAttempts})
      `);
      inserted = true;
    });

    if (!inserted) {
      throw new JobQuotaExceededError(orgId);
    }

    const [row] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    if (!row) throw new Error("Failed to retrieve enqueued job");
    return row;
  }

  // No orgId — insert unconditionally (internal/system jobs).
  const [row] = await db
    .insert(jobsTable)
    .values({
      id: jobId,
      kind,
      orgId: null,
      payload,
      status: "pending",
      maxAttempts,
    })
    .returning();
  if (!row) throw new Error("Failed to enqueue job");
  return row;
}

export async function claimNextJob(): Promise<JobRow | null> {
  // Per-org head-of-line scheduling: select the oldest pending job from each
  // org (via ROW_NUMBER window function — compatible with FOR UPDATE SKIP
  // LOCKED, unlike DISTINCT ON), then among those candidates pick the org
  // whose oldest job has been waiting the longest. The outer JOIN re-fetches
  // the chosen row from the base table so FOR UPDATE SKIP LOCKED can safely
  // skip it if another worker grabbed it first; in that case the UPDATE
  // matches 0 rows and the worker retries on the next poll interval.
  //
  // Per-tenant starvation is bounded by MAX_PENDING_JOBS_PER_ORG: at most
  // that many jobs from one org can sit ahead of a newly-arriving tenant.
  // Postgres forbids FOR UPDATE in a query containing window functions, even
  // when those windows are inside a subquery — `ERROR: FOR UPDATE is not
  // allowed with window functions`. We split the work across two CTEs:
  //   `candidate` runs the window query with no lock to pick the next job,
  //   `locked` then re-fetches that specific id with FOR UPDATE SKIP LOCKED
  //   on a window-free query, so concurrent workers safely skip claimed rows.
  // If a peer worker grabs the row between the two CTEs, `locked` returns
  // empty and the UPDATE matches 0 rows — same retry-on-next-poll behaviour.
  // Jobs whose `scheduled_for` is set in the future are in retry-backoff and
  // must be skipped until that time arrives. NULL means "ready immediately"
  // (the common case for fresh enqueues), so we coalesce to NOW().
  const result = await db.execute(sql`
    WITH candidate AS MATERIALIZED (
      SELECT id
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY enqueued_at ASC) AS rn,
               MIN(enqueued_at) OVER (PARTITION BY org_id) AS org_earliest
        FROM jobs
        WHERE status = 'pending'
          AND COALESCE(scheduled_for, NOW()) <= NOW()
      ) ranked
      WHERE rn = 1
      ORDER BY org_earliest ASC
      LIMIT 1
    ),
    locked AS (
      SELECT id
      FROM jobs
      WHERE id = (SELECT id FROM candidate)
        AND status = 'pending'
        AND COALESCE(scheduled_for, NOW()) <= NOW()
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
    SET status = 'running',
        started_at = NOW(),
        attempts = attempts + 1,
        scheduled_for = NULL
    WHERE id = (SELECT id FROM locked)
    RETURNING *
  `);
  const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
  const raw = rows[0];
  if (!raw) return null;
  // Re-select via drizzle to get typed row.
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, String(raw.id)));
  return row ?? null;
}

export async function completeJob(
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db
    .update(jobsTable)
    .set({
      status: "succeeded",
      result,
      progress: 100,
      completedAt: new Date(),
    })
    .where(eq(jobsTable.id, jobId));
}

export async function failJob(jobId: string, error: Error): Promise<void> {
  await db
    .update(jobsTable)
    .set({
      status: "failed",
      error: error.message,
      completedAt: new Date(),
      scheduledFor: null,
    })
    .where(eq(jobsTable.id, jobId));
}

/**
 * Mark a job as `cancelled`. Distinct from `failJob` so the System UI
 * can render a calm "Cancelled" badge instead of an alarming red
 * "Failed" badge for jobs the operator stopped on purpose.
 *
 * The `error` column still records the cancellation message so any
 * code that reads `error` (logs, BQ run records, retry filters) keeps
 * working — only the terminal `status` differs.
 */
export async function cancelJob(jobId: string): Promise<void> {
  await db
    .update(jobsTable)
    .set({
      status: "cancelled",
      error: CANCELLED_ERROR_MESSAGE,
      completedAt: new Date(),
      scheduledFor: null,
    })
    .where(eq(jobsTable.id, jobId));
}

/** Error message used when an operator cancels a job. */
export const CANCELLED_ERROR_MESSAGE = "Cancelled by operator";

export class JobCancellationResult {
  constructor(
    /** True if the job was actually transitioned (pending → failed). */
    readonly cancelledImmediately: boolean,
    /** True if a cancel-flag was set on a running job (worker will honour it). */
    readonly cancelRequested: boolean,
  ) {}
}

/**
 * Request cancellation of a job.
 *
 * - `pending` jobs are immediately transitioned to `failed` with the
 *   "Cancelled by operator" error (and `cancel_requested` is also set so
 *   any handler that briefly inspects the row sees it).
 * - `running` jobs have `cancel_requested` set to true. Handlers can poll
 *   `isJobCancelRequested` at safe checkpoints and bail out; in any case,
 *   the worker rewrites the terminal state to `failed` with the cancelled
 *   error message once the handler returns.
 * - Already-terminal jobs (`succeeded` / `failed`) are left untouched.
 *
 * Both transitions are performed inside a single conditional UPDATE so
 * concurrent cancel requests are idempotent.
 */
export async function requestJobCancellation(
  jobId: string,
): Promise<JobCancellationResult> {
  const now = new Date();

  // Atomically transition pending -> cancelled in one statement so a
  // worker claim cannot race the cancel. Also clear `scheduled_for` so
  // a backoff-rescheduled row that the operator cancels mid-wait
  // doesn't leave a stale next-retry time on the audit trail. We use
  // the dedicated `cancelled` status (not `failed`) so the UI can show
  // a calm Cancelled badge for operator-driven stops.
  const pendingResult = await db
    .update(jobsTable)
    .set({
      status: "cancelled",
      error: CANCELLED_ERROR_MESSAGE,
      cancelRequested: true,
      completedAt: now,
      scheduledFor: null,
    })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.status, "pending")))
    .returning({ id: jobsTable.id });
  if (pendingResult.length > 0) {
    return new JobCancellationResult(true, true);
  }

  // For running jobs, flag the row. The worker will detect this when the
  // handler returns and rewrite the terminal state.
  const runningResult = await db
    .update(jobsTable)
    .set({ cancelRequested: true })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.status, "running")))
    .returning({ id: jobsTable.id });
  if (runningResult.length > 0) {
    return new JobCancellationResult(false, true);
  }

  return new JobCancellationResult(false, false);
}

/**
 * Returns true if cancellation has been requested on this job. Long-running
 * handlers should poll this at safe checkpoints (e.g. between batches) and
 * throw `new Error(CANCELLED_ERROR_MESSAGE)` to bail out cleanly.
 */
export async function isJobCancelRequested(jobId: string): Promise<boolean> {
  const [row] = await db
    .select({ cancelRequested: jobsTable.cancelRequested })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  return row?.cancelRequested === true;
}

/**
 * Re-queue a job that just failed transiently. Sets status back to
 * `pending`, records the error message, and schedules the next claim for
 * `delayMs` in the future. Leaves `attempts` as the worker incremented it
 * on claim, and intentionally leaves `enqueued_at` untouched so per-org
 * FIFO ordering is preserved across retries.
 */
export async function scheduleRetry(
  jobId: string,
  error: Error,
  delayMs: number,
): Promise<Date> {
  const next = new Date(Date.now() + Math.max(0, delayMs));
  await db
    .update(jobsTable)
    .set({
      status: "pending",
      error: error.message,
      scheduledFor: next,
      startedAt: null,
    })
    .where(eq(jobsTable.id, jobId));
  return next;
}

/**
 * Convenience helper for handlers and the long-running code they call:
 * throws `new Error(CANCELLED_ERROR_MESSAGE)` if cancellation has been
 * requested for this job, otherwise resolves with no-op. Use at safe
 * checkpoints (between batches, between collector pages, between OODA
 * phases) so a `running` job stops within seconds of the operator
 * pressing Cancel instead of running to natural completion.
 *
 * The thrown error is the same string the worker normalizes to in
 * `processOnce`, so the terminal state remains "Cancelled by operator"
 * regardless of which checkpoint surfaces it.
 */
export async function throwIfJobCancelled(jobId: string): Promise<void> {
  if (await isJobCancelRequested(jobId)) {
    throw new Error(CANCELLED_ERROR_MESSAGE);
  }
}

export async function setJobProgress(jobId: string, pct: number): Promise<void> {
  await db
    .update(jobsTable)
    .set({ progress: Math.max(0, Math.min(100, Math.round(pct))) })
    .where(eq(jobsTable.id, jobId));
}

let workerStarted = false;
let workerHandle: ReturnType<typeof setInterval> | null = null;

export async function processOnce(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;
  const handler = handlers.get(job.kind);
  if (!handler) {
    // Unknown kind is a permanent configuration error: retrying will not
    // suddenly conjure a handler. Fail immediately, no retry.
    await failJob(
      job.id,
      new Error(`No handler registered for kind=${job.kind}`),
    );
    return true;
  }
  try {
    const result = await handler(job);
    // If the operator requested cancellation while the handler was running,
    // override the terminal state so the job shows as cancelled instead of
    // succeeded — even if the handler ignored the flag.
    if (await isJobCancelRequested(job.id)) {
      await cancelJob(job.id);
      logger.info(
        { jobId: job.id, kind: job.kind },
        "Job cancelled after handler completion",
      );
    } else {
      await completeJob(job.id, result);
      logger.info({ jobId: job.id, kind: job.kind }, "Job succeeded");
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    // Cancellation always wins over auto-retry. If the operator flipped
    // `cancel_requested` while the handler was running, normalize the
    // terminal error to CANCELLED_ERROR_MESSAGE and skip backoff —
    // automatically re-queuing a job the operator just told us to stop
    // would be both wrong and confusing on the UI.
    if (await isJobCancelRequested(job.id)) {
      logger.info(
        { jobId: job.id, kind: job.kind, err: e.message },
        "Job cancelled (handler exited with error)",
      );
      await cancelJob(job.id);
      return true;
    }
    // The worker incremented `attempts` when it claimed this job, so
    // job.attempts here is the number of attempts already consumed by
    // this run. We retry only while we have budget left AND the error is
    // not explicitly marked unrecoverable.
    const budget = job.maxAttempts ?? MAX_ATTEMPTS_BY_KIND[job.kind] ?? 3;
    const remaining = Math.max(0, budget - job.attempts);
    if (remaining > 0 && !isUnrecoverable(e)) {
      const delay = nextBackoffMs(job.attempts);
      const next = await scheduleRetry(job.id, e, delay);
      logger.warn(
        {
          jobId: job.id,
          kind: job.kind,
          tenantId: job.orgId ?? null,
          errorClass: e.name,
          attempt: job.attempts,
          maxAttempts: budget,
          retryInMs: delay,
          nextAttemptAt: next.toISOString(),
          err: e.message,
        },
        "Job failed transiently; scheduled for retry",
      );
    } else {
      // Terminal failure log line. Stable shape — tenantId, jobKind,
      // jobId, attempt, errorClass — so log filtering by any of those
      // dimensions is easy. Documented in HARDENING.md as the
      // canonical "this job will not run again" event.
      logger.error(
        {
          event: "job_terminal_failure",
          jobId: job.id,
          jobKind: job.kind,
          tenantId: job.orgId ?? null,
          errorClass: e.name,
          attempt: job.attempts,
          maxAttempts: budget,
          unrecoverable: isUnrecoverable(e),
          err: e.message,
        },
        "Job failed permanently",
      );
      await failJob(job.id, e);
    }
  }
  return true;
}

export function startWorker(intervalMs = 1000): void {
  if (workerStarted) return;
  workerStarted = true;
  workerHandle = setInterval(() => {
    processOnce().catch((err) => {
      logger.error({ err: (err as Error).message }, "Worker loop error");
    });
  }, intervalMs);
}

export function stopWorker(): void {
  if (workerHandle) clearInterval(workerHandle);
  workerHandle = null;
  workerStarted = false;
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  return row ?? null;
}

export async function listJobsByOrg(
  orgId: string,
  limit = 50,
): Promise<JobRow[]> {
  return await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.orgId, orgId))
    .orderBy(asc(jobsTable.enqueuedAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Job retention / pruning
//
// Operators don't need indefinitely-old completed jobs in the queue table,
// and the table will eventually slow down list queries / bloat backups.
// Two retention windows are tracked separately:
//   - succeeded jobs: pruned after a short window (default 7 days)
//   - failed jobs:    kept longer so operators can inspect / retry them
//                     (default 30 days)
// Both windows are configurable via env vars; the prune itself runs as a
// scheduled `prune_jobs` job (see `startJobPruner`) so it's serialized
// through the same worker that processes everything else.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_SUCCEEDED_DAYS = 7;
const DEFAULT_RETENTION_FAILED_DAYS = 30;
function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { envVar: name, value: raw, fallback },
      "Invalid env var (must be a positive number); falling back to default",
    );
    return fallback;
  }
  return n;
}

export interface JobRetentionConfig {
  succeededOlderThanMs: number;
  failedOlderThanMs: number;
}

/** Resolve the configured retention windows, in milliseconds. */
export function getJobRetentionConfig(): JobRetentionConfig {
  const succeededDays = envPositiveNumber(
    "JOB_RETENTION_SUCCEEDED_DAYS",
    DEFAULT_RETENTION_SUCCEEDED_DAYS,
  );
  const failedDays = envPositiveNumber(
    "JOB_RETENTION_FAILED_DAYS",
    DEFAULT_RETENTION_FAILED_DAYS,
  );
  return {
    succeededOlderThanMs: succeededDays * DAY_MS,
    failedOlderThanMs: failedDays * DAY_MS,
  };
}

export interface PruneJobsResult {
  succeededDeleted: number;
  failedDeleted: number;
  cancelledDeleted: number;
  succeededOlderThanMs: number;
  failedOlderThanMs: number;
}

/**
 * Delete completed jobs older than the configured retention windows.
 * Always uses `completed_at` (never `enqueued_at`) so a long-running job
 * isn't deleted out from under the worker. Leaves `pending` and `running`
 * jobs untouched.
 *
 * Cancelled jobs share the failed-retention window: an operator-cancelled
 * job is still a "did not succeed" terminal row, and operators want a
 * comparable amount of time to review it before it ages out.
 */
export async function pruneOldJobs(
  overrides: Partial<JobRetentionConfig> = {},
): Promise<PruneJobsResult> {
  const cfg = getJobRetentionConfig();
  const succeededOlderThanMs =
    overrides.succeededOlderThanMs ?? cfg.succeededOlderThanMs;
  const failedOlderThanMs =
    overrides.failedOlderThanMs ?? cfg.failedOlderThanMs;

  const now = Date.now();
  const succeededCutoff = new Date(now - succeededOlderThanMs).toISOString();
  const failedCutoff = new Date(now - failedOlderThanMs).toISOString();

  const succeededRes = await db.execute(sql`
    DELETE FROM jobs
    WHERE status = 'succeeded'
      AND completed_at IS NOT NULL
      AND completed_at < ${succeededCutoff}
    RETURNING id
  `);
  const failedRes = await db.execute(sql`
    DELETE FROM jobs
    WHERE status = 'failed'
      AND completed_at IS NOT NULL
      AND completed_at < ${failedCutoff}
    RETURNING id
  `);
  const cancelledRes = await db.execute(sql`
    DELETE FROM jobs
    WHERE status = 'cancelled'
      AND completed_at IS NOT NULL
      AND completed_at < ${failedCutoff}
    RETURNING id
  `);

  const succeededDeleted = succeededRes.rows?.length ?? 0;
  const failedDeleted = failedRes.rows?.length ?? 0;
  const cancelledDeleted = cancelledRes.rows?.length ?? 0;

  if (succeededDeleted > 0 || failedDeleted > 0 || cancelledDeleted > 0) {
    logger.info(
      {
        succeededDeleted,
        failedDeleted,
        cancelledDeleted,
        succeededOlderThanMs,
        failedOlderThanMs,
      },
      "Pruned old jobs",
    );
  }

  return {
    succeededDeleted,
    failedDeleted,
    cancelledDeleted,
    succeededOlderThanMs,
    failedOlderThanMs,
  };
}

/**
 * Fixed advisory-lock key used to serialize prune-job scheduling across
 * every process and every scheduler tick. Lives in the same namespace
 * as `JOB_ENQUEUE_LOCK_NS` so collisions with org-scoped enqueue locks
 * are impossible (different sub-key space).
 */
const PRUNE_SCHEDULE_LOCK_KEY = 0x5052554e; // "PRUN"

/**
 * Enqueue a `prune_jobs` job iff there isn't one already pending or
 * running. Returns the new job row, or `null` if a prune was already
 * scheduled.
 *
 * The check-then-insert runs under a transaction-scoped advisory lock
 * (`pg_advisory_xact_lock(JOB_ENQUEUE_LOCK_NS, PRUNE_SCHEDULE_LOCK_KEY)`)
 * so concurrent scheduler ticks — across multiple worker processes or
 * across a fast restart loop — cannot both observe "no active prune"
 * and both insert. Without this, two callers could each pass the
 * SELECT and each INSERT, leaving two pending `prune_jobs` rows.
 */
export async function ensurePruneJobScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${PRUNE_SCHEDULE_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'prune_jobs' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) {
      return; // inserted stays false; advisory lock released on tx end
    }

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'prune_jobs', NULL, '{}'::jsonb, 'pending')
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

// ─── Operator-tunable prune schedule ─────────────────────────────────────
//
// The prune cadence used to be a fixed `setInterval` driven by
// `JOB_PRUNE_INTERVAL_MS`. Operators couldn't change it without a code
// change + redeploy, which made it awkward to dial cleanup up (e.g.
// every 6h) or down per environment.
//
// Now the schedule is a cron expression persisted in `app_settings`
// under `APP_SETTING_KEY_JOB_PRUNE_SCHEDULE`. The scheduler reads it
// at startup; calling `setJobPruneSchedule` writes the new cron and
// then immediately reloads the in-process timer so the new cadence
// takes effect without a restart.

/**
 * Default cron schedule for `prune_jobs`. Equivalent to "every 6
 * hours at minute 0" (00:00, 06:00, 12:00, 18:00 UTC). Matches the
 * old fixed 6h `setInterval` cadence so existing environments see no
 * behaviour change on upgrade. The literal expression lives below
 * (kept out of the JSDoc to avoid a premature comment terminator).
 */
export const DEFAULT_JOB_PRUNE_CRON = "0 */6 * * *";

/**
 * Cap on how far in the future we'll schedule a single timer fire.
 * `setTimeout` is reliable up to ~24.8 days; we re-arm well before
 * that so a multi-day cron (e.g. monthly) stays accurate.
 */
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000; // 24h

export interface JobPruneSchedule {
  /** Cron expression currently driving the pruner. */
  cron: string;
  /** In-code default (returned even when no operator override exists). */
  defaultCron: string;
  /** True when the value comes from an operator-set `app_settings` row. */
  isOverride: boolean;
  /** Wall-clock time of the most recent operator update, or null. */
  lastChangedAt: Date | null;
  /** Email of the operator who set the current value, or null. */
  lastChangedBy: string | null;
}

/**
 * Validate a cron expression and return its parser if it's well-formed,
 * otherwise throw a descriptive `Error`. We use 5-field cron (minute /
 * hour / dom / month / dow) — the same syntax operators see in
 * `defaultScheduleCron` on collectors and in standard crontab files.
 */
export function parsePruneCron(cron: string): ReturnType<
  typeof CronExpressionParser.parse
> {
  const trimmed = (cron ?? "").trim();
  if (!trimmed) {
    throw new Error("Cron expression must not be empty");
  }
  if (trimmed.length > 120) {
    throw new Error("Cron expression must be 120 characters or fewer");
  }
  // `cron-parser` accepts both 5-field and 6-field (with seconds). We
  // explicitly reject 6-field so operators can't accidentally enqueue
  // a once-a-second prune; the smallest meaningful tick is one minute.
  const partCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (partCount !== 5 && !trimmed.startsWith("@")) {
    throw new Error(
      "Cron expression must have exactly 5 fields (minute hour dom month dow)",
    );
  }
  try {
    return CronExpressionParser.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cron expression: ${msg}`);
  }
}

interface StoredPruneScheduleValue {
  cron: string;
}

function readStoredCron(row: AppSettingRow | undefined): string | null {
  if (!row) return null;
  const value = row.value as Partial<StoredPruneScheduleValue> | null;
  const cron = value?.cron;
  if (typeof cron !== "string" || cron.trim() === "") return null;
  return cron.trim();
}

/**
 * Read the configured job-prune schedule. Falls back to
 * `DEFAULT_JOB_PRUNE_CRON` when no operator override exists OR when
 * the stored value fails cron parsing (defensive — a malformed row
 * should never wedge the pruner).
 */
export async function getJobPruneSchedule(): Promise<JobPruneSchedule> {
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, APP_SETTING_KEY_JOB_PRUNE_SCHEDULE));
  const stored = readStoredCron(row);
  let cron = DEFAULT_JOB_PRUNE_CRON;
  let isOverride = false;
  if (stored) {
    try {
      parsePruneCron(stored);
      cron = stored;
      isOverride = true;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, stored },
        "Stored job_prune_schedule is invalid; falling back to default",
      );
    }
  }
  return {
    cron,
    defaultCron: DEFAULT_JOB_PRUNE_CRON,
    isOverride,
    lastChangedAt: row?.lastChangedAt ?? row?.updatedAt ?? null,
    lastChangedBy: row?.lastChangedBy ?? null,
  };
}

/**
 * Compute the next time the pruner should fire given the current
 * cron, anchored at `from` (defaults to now). Returns a JS `Date`.
 */
export async function getNextJobPruneRunAt(from?: Date): Promise<Date> {
  const { cron } = await getJobPruneSchedule();
  const expr = CronExpressionParser.parse(cron, {
    currentDate: from ?? new Date(),
  });
  return expr.next().toDate();
}

/**
 * Persist a new cron schedule for the job pruner and reload the
 * in-process timer so the change takes effect immediately. Validates
 * the cron up front; throws if invalid (the route returns 400).
 *
 * `actorEmail` is recorded for the audit trail so the System page can
 * show who tuned the schedule.
 */
export async function setJobPruneSchedule(args: {
  cron: string;
  actorEmail: string | null;
}): Promise<JobPruneSchedule> {
  parsePruneCron(args.cron); // throws if invalid
  const cron = args.cron.trim();
  const now = new Date();
  await db
    .insert(appSettingsTable)
    .values({
      key: APP_SETTING_KEY_JOB_PRUNE_SCHEDULE,
      value: { cron } satisfies StoredPruneScheduleValue,
      lastChangedAt: now,
      lastChangedBy: args.actorEmail,
    })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: {
        value: { cron } satisfies StoredPruneScheduleValue,
        lastChangedAt: now,
        lastChangedBy: args.actorEmail,
      },
    });
  // Reload the live timer so the operator sees the new cadence apply
  // immediately rather than only on the next process restart.
  if (prunerStarted) {
    armPrunerTimer();
  }
  logger.info(
    { cron, actor: args.actorEmail },
    "Updated job_prune_schedule",
  );
  return getJobPruneSchedule();
}

let prunerStarted = false;
let prunerHandle: ReturnType<typeof setTimeout> | null = null;

function clearPrunerTimer(): void {
  if (prunerHandle) {
    clearTimeout(prunerHandle);
    prunerHandle = null;
  }
}

/**
 * (Re)compute the next-run delay from the persisted cron and arm a
 * single `setTimeout`. When it fires, enqueue a prune and re-arm.
 * Long delays are split into ≤24h chunks so we never exceed Node's
 * `setTimeout` upper bound (~24.8 days) when an operator picks an
 * infrequent cron.
 */
function armPrunerTimer(): void {
  clearPrunerTimer();
  if (!prunerStarted) return;
  void (async () => {
    let nextAt: Date;
    try {
      nextAt = await getNextJobPruneRunAt();
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        "Failed to compute next prune run; retrying in 1 minute",
      );
      prunerHandle = setTimeout(armPrunerTimer, 60_000);
      return;
    }
    const delay = Math.max(0, nextAt.getTime() - Date.now());
    if (delay > MAX_TIMER_DELAY_MS) {
      // Re-arm after the 24h chunk; the next call will recompute the
      // remaining delay (and may chunk again).
      prunerHandle = setTimeout(armPrunerTimer, MAX_TIMER_DELAY_MS);
      return;
    }
    prunerHandle = setTimeout(() => {
      ensurePruneJobScheduled()
        .catch((err) => {
          logger.error(
            { err: (err as Error).message },
            "Failed to enqueue scheduled prune_jobs",
          );
        })
        .finally(() => {
          // Re-arm even on enqueue failure so a transient DB hiccup
          // doesn't permanently disable the pruner.
          armPrunerTimer();
        });
    }, delay);
  })();
}

/**
 * Start the periodic job-pruner scheduler. Enqueues a `prune_jobs` job
 * immediately at startup so the first prune happens promptly after
 * boot, then arms a cron-driven timer (default cadence is every 6
 * hours; see `DEFAULT_JOB_PRUNE_CRON`). Operators can override the
 * schedule from the System page via `setJobPruneSchedule`.
 * Idempotent — calling twice has no effect.
 */
export function startJobPruner(): void {
  if (prunerStarted) return;
  prunerStarted = true;

  // Run once at startup so the first prune happens promptly after boot
  // even if the next cron tick is far in the future.
  void ensurePruneJobScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial prune_jobs",
    );
  });

  armPrunerTimer();
}

export function stopJobPruner(): void {
  clearPrunerTimer();
  prunerStarted = false;
}

// ─── Funnel-snapshot retention pruner ────────────────────────────────────
//
// `funnel_snapshots` rows carry a sizable JSONB payload (16 stage entries
// with sample IDs, cohort drill-down, calibration). One cycle per 6h per
// tenant is ~1,460 rows/year/tenant — without retention the table grows
// unboundedly and the admin observability page eventually pays for it on
// every read. A daily prune of snapshots older than 365 days plus a
// post-prune VACUUM keeps the table bounded with no operator effort.
//
// Same job also prunes `funnel_snapshot_failures` older than its own
// (shorter) window — failures are diagnostic noise once acked and aged
// out. Both windows are env-overridable; defaults are conservative.
// ---------------------------------------------------------------------------

const DEFAULT_FUNNEL_SNAPSHOT_RETENTION_DAYS = 365;
const DEFAULT_FUNNEL_FAILURE_RETENTION_DAYS = 90;
const DEFAULT_FUNNEL_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Hard limits on operator-tunable retention windows. Days must be a
 * positive integer; the upper bound (3650d ≈ 10 years) keeps a typo
 * from accidentally pinning every snapshot ever written.
 */
const FUNNEL_RETENTION_MIN_DAYS = 1;
const FUNNEL_RETENTION_MAX_DAYS = 3650;

export interface FunnelSnapshotRetentionConfig {
  snapshotsOlderThanMs: number;
  failuresOlderThanMs: number;
}

/**
 * Operator-facing retention metadata. Mirrors the
 * `JobPruneSchedule` shape so the System page can render the same
 * "default vs override" UX next to the funnel snapshot cleanup card.
 */
export interface FunnelSnapshotRetentionSettings {
  /** Active snapshot retention window, in days (integer). */
  snapshotDays: number;
  /** Active failure-row retention window, in days (integer). */
  failureDays: number;
  /** Bootstrap default snapshot window from env / in-code constant. */
  defaultSnapshotDays: number;
  /** Bootstrap default failure window from env / in-code constant. */
  defaultFailureDays: number;
  /** True when an operator override exists in `app_settings`. */
  isOverride: boolean;
  /** Wall-clock time of the most recent operator update, or null. */
  lastChangedAt: Date | null;
  /** Email of the operator who set the current value, or null. */
  lastChangedBy: string | null;
}

/**
 * Resolve the bootstrap defaults from env vars (with a hard-coded
 * fallback). These are the values used until an operator writes an
 * override row in `app_settings`. Surfaced separately so the System
 * page can render a "Default: Nd" hint next to the editable input.
 */
export function getFunnelSnapshotRetentionDefaults(): {
  snapshotDays: number;
  failureDays: number;
} {
  const snapshotDays = envPositiveNumber(
    "FUNNEL_SNAPSHOT_RETENTION_DAYS",
    DEFAULT_FUNNEL_SNAPSHOT_RETENTION_DAYS,
  );
  const failureDays = envPositiveNumber(
    "FUNNEL_SNAPSHOT_FAILURE_RETENTION_DAYS",
    DEFAULT_FUNNEL_FAILURE_RETENTION_DAYS,
  );
  return { snapshotDays, failureDays };
}

interface StoredFunnelRetentionValue {
  snapshotDays: number;
  failureDays: number;
}

function readStoredFunnelRetention(
  row: AppSettingRow | undefined,
): StoredFunnelRetentionValue | null {
  if (!row) return null;
  const value = row.value as Partial<StoredFunnelRetentionValue> | null;
  const snap = value?.snapshotDays;
  const fail = value?.failureDays;
  if (
    typeof snap !== "number" ||
    !Number.isFinite(snap) ||
    !Number.isInteger(snap) ||
    snap < FUNNEL_RETENTION_MIN_DAYS ||
    snap > FUNNEL_RETENTION_MAX_DAYS
  ) {
    return null;
  }
  if (
    typeof fail !== "number" ||
    !Number.isFinite(fail) ||
    !Number.isInteger(fail) ||
    fail < FUNNEL_RETENTION_MIN_DAYS ||
    fail > FUNNEL_RETENTION_MAX_DAYS
  ) {
    return null;
  }
  return { snapshotDays: snap, failureDays: fail };
}

/**
 * Read the currently-active funnel-snapshot retention windows along
 * with the audit metadata. Falls back to the env-derived defaults
 * (see `getFunnelSnapshotRetentionDefaults`) when no operator
 * override exists, or when the stored row fails validation
 * (defensive — a malformed row should never wedge the pruner).
 */
export async function getFunnelSnapshotRetentionSettings(): Promise<FunnelSnapshotRetentionSettings> {
  const defaults = getFunnelSnapshotRetentionDefaults();
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, APP_SETTING_KEY_FUNNEL_SNAPSHOT_RETENTION));
  const stored = readStoredFunnelRetention(row);
  if (!stored) {
    if (row) {
      logger.warn(
        { stored: row.value },
        "Stored funnel_snapshot_retention is invalid; falling back to defaults",
      );
    }
    return {
      snapshotDays: defaults.snapshotDays,
      failureDays: defaults.failureDays,
      defaultSnapshotDays: defaults.snapshotDays,
      defaultFailureDays: defaults.failureDays,
      isOverride: false,
      lastChangedAt: null,
      lastChangedBy: null,
    };
  }
  return {
    snapshotDays: stored.snapshotDays,
    failureDays: stored.failureDays,
    defaultSnapshotDays: defaults.snapshotDays,
    defaultFailureDays: defaults.failureDays,
    isOverride: true,
    lastChangedAt: row?.lastChangedAt ?? row?.updatedAt ?? null,
    lastChangedBy: row?.lastChangedBy ?? null,
  };
}

/**
 * Resolve the configured funnel-snapshot retention windows, in
 * milliseconds. Reads the persisted operator override from
 * `app_settings`, falling back to env-derived defaults when none
 * exists. Async because the read goes through the DB; callers must
 * `await` the result.
 */
export async function getFunnelSnapshotRetentionConfig(): Promise<FunnelSnapshotRetentionConfig> {
  const settings = await getFunnelSnapshotRetentionSettings();
  return {
    snapshotsOlderThanMs: settings.snapshotDays * DAY_MS,
    failuresOlderThanMs: settings.failureDays * DAY_MS,
  };
}

/**
 * Validate a proposed funnel-snapshot retention day count. Throws a
 * descriptive `Error` when out of bounds; the route turns the message
 * into a 400 response.
 */
function validateRetentionDays(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < FUNNEL_RETENTION_MIN_DAYS || value > FUNNEL_RETENTION_MAX_DAYS) {
    throw new Error(
      `${label} must be between ${FUNNEL_RETENTION_MIN_DAYS} and ${FUNNEL_RETENTION_MAX_DAYS} days`,
    );
  }
  return value;
}

/**
 * Persist a new funnel-snapshot retention override and return the
 * fresh settings row. The next `prune_funnel_snapshots` run picks the
 * value up automatically — no in-process timer to reload because the
 * pruner reads the cutoffs at execution time, not at scheduler arming.
 */
export async function setFunnelSnapshotRetentionSettings(args: {
  snapshotDays: number;
  failureDays: number;
  actorEmail: string | null;
}): Promise<FunnelSnapshotRetentionSettings> {
  const snapshotDays = validateRetentionDays("snapshotDays", args.snapshotDays);
  const failureDays = validateRetentionDays("failureDays", args.failureDays);
  const now = new Date();
  await db
    .insert(appSettingsTable)
    .values({
      key: APP_SETTING_KEY_FUNNEL_SNAPSHOT_RETENTION,
      value: { snapshotDays, failureDays } satisfies StoredFunnelRetentionValue,
      lastChangedAt: now,
      lastChangedBy: args.actorEmail,
    })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: {
        value: {
          snapshotDays,
          failureDays,
        } satisfies StoredFunnelRetentionValue,
        lastChangedAt: now,
        lastChangedBy: args.actorEmail,
      },
    });
  logger.info(
    { snapshotDays, failureDays, actor: args.actorEmail },
    "Updated funnel_snapshot_retention",
  );
  return getFunnelSnapshotRetentionSettings();
}

export interface PruneFunnelSnapshotsResult {
  snapshotsDeleted: number;
  failuresDeleted: number;
  snapshotsOlderThanMs: number;
  failuresOlderThanMs: number;
  /**
   * True when the post-prune `VACUUM funnel_snapshots` succeeded. False
   * when it was skipped (no rows deleted) or failed (e.g. running
   * through pgbouncer in transaction-pooling mode, or insufficient
   * privileges). Surfaces a single boolean to operators rather than
   * the full PG error so the System UI can show a calm "vacuum
   * skipped" badge instead of a scary stack trace.
   */
  vacuumed: boolean;
}

/**
 * Delete `funnel_snapshots` rows older than the configured snapshot
 * window (cascading `funnel_annotations` go with them via the FK
 * `ON DELETE CASCADE`), and delete `funnel_snapshot_failures` older
 * than the configured failures window. Returns the per-table delete
 * counts plus whether the post-prune VACUUM succeeded.
 *
 * The `created_at` cutoff is applied per-table, never `enqueued_at` or
 * any other field, so a freshly-captured snapshot is never collected
 * out from under the writer. Failures use `last_seen_at` for the same
 * "still-fresh diagnostic" reason.
 */
export async function pruneOldFunnelSnapshots(
  overrides: Partial<FunnelSnapshotRetentionConfig> = {},
): Promise<PruneFunnelSnapshotsResult> {
  const cfg = await getFunnelSnapshotRetentionConfig();
  const snapshotsOlderThanMs =
    overrides.snapshotsOlderThanMs ?? cfg.snapshotsOlderThanMs;
  const failuresOlderThanMs =
    overrides.failuresOlderThanMs ?? cfg.failuresOlderThanMs;

  const now = Date.now();
  const snapshotsCutoff = new Date(
    now - snapshotsOlderThanMs,
  ).toISOString();
  const failuresCutoff = new Date(
    now - failuresOlderThanMs,
  ).toISOString();

  const snapshotsRes = await db.execute(sql`
    DELETE FROM funnel_snapshots
    WHERE created_at < ${snapshotsCutoff}
    RETURNING id
  `);
  const failuresRes = await db.execute(sql`
    DELETE FROM funnel_snapshot_failures
    WHERE last_seen_at < ${failuresCutoff}
    RETURNING id
  `);

  const snapshotsDeleted = snapshotsRes.rows?.length ?? 0;
  const failuresDeleted = failuresRes.rows?.length ?? 0;

  let vacuumed = false;
  if (snapshotsDeleted > 0 || failuresDeleted > 0) {
    // VACUUM cannot run inside a transaction block. node-postgres' pool
    // runs single statements as autocommit, so this works in normal
    // dev/prod setups but can fail under pgbouncer transaction pooling
    // or when the DB role lacks privileges. Treat failure as a soft
    // signal — the prune itself already succeeded — and surface it via
    // `vacuumed: false` so operators see something actionable on the
    // System page without the job itself failing.
    try {
      if (snapshotsDeleted > 0) {
        await db.execute(sql`VACUUM funnel_snapshots`);
      }
      if (failuresDeleted > 0) {
        await db.execute(sql`VACUUM funnel_snapshot_failures`);
      }
      vacuumed = true;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "VACUUM after funnel-snapshot prune failed; rows were deleted but space was not reclaimed",
      );
      vacuumed = false;
    }
  }

  if (snapshotsDeleted > 0 || failuresDeleted > 0) {
    logger.info(
      {
        snapshotsDeleted,
        failuresDeleted,
        snapshotsOlderThanMs,
        failuresOlderThanMs,
        vacuumed,
      },
      "Pruned old funnel snapshots",
    );
  }

  return {
    snapshotsDeleted,
    failuresDeleted,
    snapshotsOlderThanMs,
    failuresOlderThanMs,
    vacuumed,
  };
}

/**
 * Fixed advisory-lock key used to serialize funnel-snapshot prune
 * scheduling across every process and every scheduler tick. Distinct
 * sub-key from `PRUNE_SCHEDULE_LOCK_KEY` so the two pruners can never
 * accidentally serialize against each other.
 */
const FUNNEL_PRUNE_SCHEDULE_LOCK_KEY = 0x46554e50; // "FUNP"

/**
 * Enqueue a `prune_funnel_snapshots` job iff there isn't one already
 * pending or running. Returns the new job row, or `null` if a prune was
 * already scheduled. Same advisory-lock-protected check-then-insert as
 * `ensurePruneJobScheduled` so concurrent scheduler ticks across
 * multiple worker processes can't both observe "no active prune" and
 * both INSERT.
 */
export async function ensureFunnelSnapshotPruneJobScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${FUNNEL_PRUNE_SCHEDULE_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'prune_funnel_snapshots' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) {
      return; // inserted stays false; advisory lock released on tx end
    }

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'prune_funnel_snapshots', NULL, '{}'::jsonb, 'pending')
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

/**
 * Advisory-lock sub-key for the funnel-backfill enqueue helper.
 * Distinct from the prune sub-keys so a backfill enqueue and a prune
 * enqueue cannot accidentally serialize against each other.
 */
const FUNNEL_BACKFILL_SCHEDULE_LOCK_KEY = 0x46424b46; // "FBKF"

/**
 * Enqueue a `backfill_funnel_snapshots` job iff there isn't one
 * already pending or running. Returns the new job row, or `null` if a
 * backfill is already scheduled. Same advisory-lock-protected
 * check-then-insert as `ensurePruneJobScheduled` so concurrent
 * scheduler ticks / operator clicks across multiple worker processes
 * cannot both observe "no active backfill" and both INSERT.
 *
 * Coalescing is intentionally kind-only (regardless of the optional
 * `orgId` payload): the operator sees a single in-flight backfill at
 * a time, mirroring the cleanup card pattern. If a per-tenant backfill
 * is already running and the operator clicks "all tenants", the
 * existing job is reused — they can re-trigger after it completes.
 */
export async function ensureBackfillFunnelSnapshotsJobScheduled(
  orgId: string | null,
): Promise<JobRow | null> {
  const jobId = newId("job");
  const payload = orgId ? { orgId } : {};
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${FUNNEL_BACKFILL_SCHEDULE_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'backfill_funnel_snapshots' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) {
      return; // inserted stays false; advisory lock released on tx end
    }

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'backfill_funnel_snapshots', NULL, ${JSON.stringify(payload)}::jsonb, 'pending')
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

let funnelPrunerStarted = false;
let funnelPrunerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic funnel-snapshot pruner scheduler. Enqueues a
 * `prune_funnel_snapshots` job at boot, then again on a fixed interval
 * (default 24h, overridable via `FUNNEL_SNAPSHOT_PRUNE_INTERVAL_MS`).
 * Idempotent — calling twice has no effect.
 */
export function startFunnelSnapshotPruner(intervalMs?: number): void {
  if (funnelPrunerStarted) return;
  funnelPrunerStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber(
      "FUNNEL_SNAPSHOT_PRUNE_INTERVAL_MS",
      DEFAULT_FUNNEL_PRUNE_INTERVAL_MS,
    );

  void ensureFunnelSnapshotPruneJobScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial prune_funnel_snapshots",
    );
  });

  funnelPrunerHandle = setInterval(() => {
    ensureFunnelSnapshotPruneJobScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled prune_funnel_snapshots",
      );
    });
  }, ms);
}

export function stopFunnelSnapshotPruner(): void {
  if (funnelPrunerHandle) clearInterval(funnelPrunerHandle);
  funnelPrunerHandle = null;
  funnelPrunerStarted = false;
}

// ─── Daily renewal-alert scheduler ───────────────────────────────────────
//
// Same shape as the prune scheduler: a fixed advisory-lock-protected
// "ensure exactly one pending/running renewal_alert_scan" helper, plus
// a process-local interval that keeps re-checking. The renewal-alert
// handler itself iterates every tenant and is therefore enqueued
// without an `org_id` (system-scoped) — one job per tick covers every
// tenant.

const RENEWAL_SCAN_LOCK_KEY = 0x52454e57; // "RENW"
const DEFAULT_RENEWAL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export async function ensureRenewalScanScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${RENEWAL_SCAN_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'renewal_alert_scan' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) return;

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'renewal_alert_scan', NULL, '{}'::jsonb, 'pending')
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

let renewalScanStarted = false;
let renewalScanHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic renewal-alert scheduler. Enqueues a
 * `renewal_alert_scan` job at boot, then again on a fixed interval
 * (default 24h, overridable via `RENEWAL_SCAN_INTERVAL_MS`).
 * Idempotent — calling twice has no effect.
 */
export function startRenewalScanScheduler(intervalMs?: number): void {
  if (renewalScanStarted) return;
  renewalScanStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber(
      "RENEWAL_SCAN_INTERVAL_MS",
      DEFAULT_RENEWAL_SCAN_INTERVAL_MS,
    );

  void ensureRenewalScanScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial renewal_alert_scan",
    );
  });

  renewalScanHandle = setInterval(() => {
    ensureRenewalScanScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled renewal_alert_scan",
      );
    });
  }, ms);
}

export function stopRenewalScanScheduler(): void {
  if (renewalScanHandle) clearInterval(renewalScanHandle);
  renewalScanHandle = null;
  renewalScanStarted = false;
}

// ─── Periodic OODA analysis-cycle scheduler ──────────────────────────────
//
// Same shape as the renewal-alert scheduler. The analysis cycle handler
// is per-tenant (requires `org_id`), so on each tick we enqueue a single
// system-scoped `analysis_cycle_fanout` job whose handler iterates every
// org and enqueues one `run_analysis_cycle` job per tenant — keeping each
// tenant's run individually visible/retryable on the System / Jobs page.

const ANALYSIS_CYCLE_LOCK_KEY = 0x4f4f4441; // "OODA"
const DEFAULT_ANALYSIS_CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export async function ensureAnalysisCycleFanoutScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${ANALYSIS_CYCLE_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'analysis_cycle_fanout' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) return;

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'analysis_cycle_fanout', NULL, '{}'::jsonb, 'pending')
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

let analysisCycleStarted = false;
let analysisCycleHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic OODA analysis-cycle scheduler. Enqueues an
 * `analysis_cycle_fanout` job at boot, then again on a fixed interval
 * (default 6h, overridable via `ANALYSIS_CYCLE_INTERVAL_MS`).
 * Idempotent — calling twice has no effect.
 */
export function startAnalysisCycleScheduler(intervalMs?: number): void {
  if (analysisCycleStarted) return;
  analysisCycleStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber(
      "ANALYSIS_CYCLE_INTERVAL_MS",
      DEFAULT_ANALYSIS_CYCLE_INTERVAL_MS,
    );

  void ensureAnalysisCycleFanoutScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial analysis_cycle_fanout",
    );
  });

  analysisCycleHandle = setInterval(() => {
    ensureAnalysisCycleFanoutScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled analysis_cycle_fanout",
      );
    });
  }, ms);
}

export function stopAnalysisCycleScheduler(): void {
  if (analysisCycleHandle) clearInterval(analysisCycleHandle);
  analysisCycleHandle = null;
  analysisCycleStarted = false;
}

// ─── Periodic routing health-check scheduler (task #213) ──────────────
//
// Same shape as the renewal-alert scheduler: a fixed advisory-lock-
// protected "ensure exactly one pending/running routing_health_check"
// helper plus a process-local interval. The routing health check is
// system-scoped (no `org_id`) — it compares the global truth tables
// against the global materialized view. If drift is detected and a
// refresh can't recover, the handler throws and the resulting failed
// job row gets picked up by `synthesize_operational_alerts` as an
// `operational_job_failed` alert on the next tick — the
// "snapshot-failure-style alert" the routing spec calls for.

const ROUTING_HEALTH_LOCK_KEY = 0x52545448; // "RTTH"
const DEFAULT_ROUTING_HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export async function ensureRoutingHealthCheckScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${ROUTING_HEALTH_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'routing_health_check' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) return;

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'routing_health_check', NULL, '{}'::jsonb, 'pending')
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

let routingHealthStarted = false;
let routingHealthHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic routing-health scheduler. Enqueues a
 * `routing_health_check` job at boot, then again on a fixed interval
 * (default 6h, overridable via `ROUTING_HEALTH_INTERVAL_MS`).
 * Idempotent — calling twice has no effect.
 */
export function startRoutingHealthScheduler(intervalMs?: number): void {
  if (routingHealthStarted) return;
  routingHealthStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber(
      "ROUTING_HEALTH_INTERVAL_MS",
      DEFAULT_ROUTING_HEALTH_INTERVAL_MS,
    );

  void ensureRoutingHealthCheckScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial routing_health_check",
    );
  });

  routingHealthHandle = setInterval(() => {
    ensureRoutingHealthCheckScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled routing_health_check",
      );
    });
  }, ms);
}

export function stopRoutingHealthScheduler(): void {
  if (routingHealthHandle) clearInterval(routingHealthHandle);
  routingHealthHandle = null;
  routingHealthStarted = false;
}

// ─── Defense Pack staleness scheduler (task #178) ─────────────────────
//
// Mirrors the routing-health pattern: an advisory-lock-protected
// "ensure exactly one pending/running staleness scan" helper, plus a
// process-local interval that fires once a day. The scan is
// system-scoped (no `org_id`); the handler walks every tenant and
// every `ready` Defense Pack, comparing each frozen
// `evidence_snapshot` row against the current `market_signals` for
// the same signal stream and flipping the pack-level `stale` flag
// when median absolute drift exceeds the configured threshold
// (default 5%, overridable via `DEFENSE_PACK_STALE_THRESHOLD`).
//
// The scan never mutates the memo itself — defensibility requires
// the cited evidence stay frozen — so it is safe to retry. Failed
// runs surface via `synthesize_operational_alerts` like every other
// system job.

const DEFENSE_PACK_STALENESS_LOCK_KEY = 0x44505353; // "DPSS"
const DEFAULT_DEFENSE_PACK_STALENESS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export async function ensureDefensePackStalenessScanScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${DEFENSE_PACK_STALENESS_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'defense_pack_staleness_scan'
        AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) return;

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'defense_pack_staleness_scan', NULL, '{}'::jsonb, 'pending')
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

let defensePackStalenessStarted = false;
let defensePackStalenessHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the nightly Defense Pack staleness scheduler. Enqueues a
 * `defense_pack_staleness_scan` job at boot, then again on a fixed
 * interval (default 24h, overridable via
 * `DEFENSE_PACK_STALENESS_SCAN_INTERVAL_MS`). Idempotent — calling
 * twice has no effect.
 */
export function startDefensePackStalenessScheduler(intervalMs?: number): void {
  if (defensePackStalenessStarted) return;
  defensePackStalenessStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber(
      "DEFENSE_PACK_STALENESS_SCAN_INTERVAL_MS",
      DEFAULT_DEFENSE_PACK_STALENESS_INTERVAL_MS,
    );

  void ensureDefensePackStalenessScanScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial defense_pack_staleness_scan",
    );
  });

  defensePackStalenessHandle = setInterval(() => {
    ensureDefensePackStalenessScanScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled defense_pack_staleness_scan",
      );
    });
  }, ms);
}

export function stopDefensePackStalenessScheduler(): void {
  if (defensePackStalenessHandle) clearInterval(defensePackStalenessHandle);
  defensePackStalenessHandle = null;
  defensePackStalenessStarted = false;
}

/**
 * Atomic per-tenant dedupe + enqueue for `run_analysis_cycle`, used by
 * the analysis-cycle fan-out handler.
 *
 * Why a dedicated helper instead of just calling `enqueueJob`?
 * `enqueueJob`'s quota check + INSERT runs under the per-org advisory
 * lock keyed by `stringHash32(orgId)`. If the fan-out handler did a
 * separate `SELECT ... status IN ('pending','running')` _outside_ that
 * lock and then called `enqueueJob`, a concurrent operator clicking
 * "Run now" (or another in-flight fan-out attempt) could enqueue
 * between our SELECT and our INSERT — defeating the dedupe and producing
 * duplicate cycles for the same tenant. Folding the in-flight check
 * into the same advisory-lock-protected transaction closes that race.
 *
 * Return value:
 *   - `{ enqueued: true, job }`  when a new cycle was enqueued.
 *   - `{ enqueued: false, reason: "in_flight" }`  when a pending/running
 *     `run_analysis_cycle` already exists for this org.
 *   - `{ enqueued: false, reason: "quota_exceeded" }` when the per-org
 *     pending+running quota is full.
 */
export async function ensureOrgAnalysisCycleScheduled(
  orgId: string,
  options: { payload?: Record<string, unknown> } = {},
): Promise<
  | { enqueued: true; job: JobRow }
  | { enqueued: false; reason: "in_flight"; existingJobId: string }
  | { enqueued: false; reason: "quota_exceeded" }
> {
  const jobId = newId("job");
  const lockKey = stringHash32(orgId);
  const maxAttempts = Math.max(
    1,
    Math.floor(await resolveMaxAttempts("run_analysis_cycle", orgId)),
  );
  const payload = options.payload ?? { source: "scheduler" };

  let outcome:
    | { enqueued: true }
    | { enqueued: false; reason: "in_flight"; existingJobId: string }
    | { enqueued: false; reason: "quota_exceeded" } = {
    enqueued: false,
    reason: "quota_exceeded",
  };

  await db.transaction(async (tx) => {
    // Same per-org lock `enqueueJob` uses for its quota+INSERT, so this
    // dedupe check, the quota check, and the INSERT all see a consistent
    // snapshot — no concurrent enqueue (manual or scheduled) can slip in
    // between them.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${lockKey})`,
    );

    // Order by enqueued_at so the oldest in-flight cycle wins. Callers
    // that map this back to a UI status row (e.g. the manual "Run now"
    // button on /cycles/run?async=true) get a stable id to poll, even
    // if multiple `run_analysis_cycle` rows briefly coexist while the
    // worker drains them.
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM jobs
      WHERE org_id = ${orgId}
        AND kind = 'run_analysis_cycle'
        AND status IN ('pending', 'running')
      ORDER BY enqueued_at ASC
      LIMIT 1
    `);
    const firstRow = existing.rows[0];
    if (firstRow) {
      outcome = {
        enqueued: false,
        reason: "in_flight",
        existingJobId: firstRow.id,
      };
      return;
    }

    const countResult = await tx.execute(sql`
      SELECT COUNT(*) AS cnt FROM jobs
      WHERE org_id = ${orgId} AND status IN ('pending', 'running')
    `);
    const rows = (countResult.rows ?? []) as Array<Record<string, unknown>>;
    const current = Number(rows[0]?.cnt ?? 0);
    if (current >= MAX_PENDING_JOBS_PER_ORG) {
      outcome = { enqueued: false, reason: "quota_exceeded" };
      return;
    }

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status, max_attempts)
      VALUES (
        ${jobId},
        'run_analysis_cycle',
        ${orgId},
        ${JSON.stringify(payload)}::jsonb,
        'pending',
        ${maxAttempts}
      )
    `);
    outcome = { enqueued: true };
  });

  if (!outcome.enqueued) return outcome;

  const [row] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!row) {
    throw new Error("Failed to retrieve enqueued analysis-cycle job");
  }
  return { enqueued: true, job: row };
}

// ─── Auto-expire stale `proposed` opportunities (task #219) ──────────────
//
// Without this, the pending-approvals queue grows forever: every cycle
// that observes the same signal would either re-insert a duplicate
// (pre-#219) or refresh-in-place (post-#219), but signals that GO AWAY
// would still leave the original `proposed` row sitting there
// indefinitely. This sweep flips rows that have either:
//
//   (a) sat in `proposed` past the absolute TTL (`OPPORTUNITY_TTL_DAYS`,
//       default 30d), measured against `created_at`, OR
//   (b) been quiet for `OPPORTUNITY_QUIET_CYCLES` consecutive completed
//       cycles (default 3), measured against `last_seen_at` vs the
//       Nth-most-recent completed cycle's `completed_at`.
//
// to status `expired`. Expired rows are excluded from the pending
// counts (Today, opportunities list defaults) but stay queryable via
// `?status=expired` so an operator can audit what went away. The
// scheduler runs once a day by default; the per-org cycle-count check
// is a single subquery so a tenant with 10k tenants still finishes in
// well under the worker timeout.

const EXPIRE_STALE_OPPS_LOCK_KEY = 0x45585053; // "EXPS"
const DEFAULT_OPPORTUNITY_TTL_DAYS = 30;
const DEFAULT_OPPORTUNITY_QUIET_CYCLES = 3;
const DEFAULT_EXPIRE_STALE_OPPS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export interface OpportunityExpiryConfig {
  /** Absolute age cutoff measured from `opportunities.created_at`. */
  ttlDays: number;
  /**
   * Number of consecutive completed cycles a row may go unrefreshed
   * before it ages out. The handler resolves the Nth-most-recent
   * cycle's `completed_at` per org and treats `last_seen_at` strictly
   * older than that as stale.
   */
  quietCycles: number;
}

export function getOpportunityExpiryConfig(): OpportunityExpiryConfig {
  return {
    ttlDays: envPositiveNumber(
      "OPPORTUNITY_TTL_DAYS",
      DEFAULT_OPPORTUNITY_TTL_DAYS,
    ),
    quietCycles: Math.max(
      1,
      Math.floor(
        envPositiveNumber(
          "OPPORTUNITY_QUIET_CYCLES",
          DEFAULT_OPPORTUNITY_QUIET_CYCLES,
        ),
      ),
    ),
  };
}

export interface ExpireStaleOpportunitiesResult {
  orgsScanned: number;
  ttlExpired: number;
  quietCyclesExpired: number;
  totalExpired: number;
  ttlDays: number;
  quietCycles: number;
}

/**
 * Walk every tenant and flip stale `proposed` opportunities to
 * `expired`. Per-org so the cycle-count subquery can use the per-org
 * `analysis_cycles` index without scanning the whole table.
 *
 * The two cutoff predicates (TTL and quiet-cycles) are deliberately
 * applied in two separate UPDATEs so the result row can report each
 * cause's count independently — operators on the System / Jobs page
 * want to know "are we expiring on age or on quietness" without
 * digging through individual rows.
 *
 * NULL `last_seen_at` rows (legacy, pre-#219) are only candidates for
 * the TTL sweep; the quiet-cycles SQL `last_seen_at < <cutoff>` is
 * NULL-comparing to NULL → the row simply isn't matched. That's the
 * correct behaviour: a row with no `last_seen_at` carries no signal
 * about cycle freshness, so only the absolute TTL applies.
 */
export async function expireStaleOpportunities(
  overrides: Partial<OpportunityExpiryConfig> = {},
): Promise<ExpireStaleOpportunitiesResult> {
  const cfg = getOpportunityExpiryConfig();
  const ttlDays = overrides.ttlDays ?? cfg.ttlDays;
  const quietCycles = Math.max(
    1,
    Math.floor(overrides.quietCycles ?? cfg.quietCycles),
  );
  const ttlCutoff = new Date(
    Date.now() - ttlDays * DAY_MS,
  ).toISOString();

  // TTL sweep — applies to every org in one statement; doesn't need
  // any cycle lookup. Keep canonical_stage / savings_type / stage_entered_at
  // in sync with the status transition, and seed one history row per
  // expired opportunity so the audit trail is complete.
  const ttlRes = await db.execute<{ id: string; org_id: string }>(sql`
    UPDATE opportunities
    SET status = 'expired',
        expiry_reason = 'ttl',
        canonical_stage = 'Closed-No Action',
        savings_type = 'Identified',
        stage_entered_at = now()
    WHERE status = 'proposed'
      AND created_at < ${ttlCutoff}
    RETURNING id, org_id
  `);
  const ttlExpired = ttlRes.rows?.length ?? 0;
  if (ttlExpired > 0) {
    await db.execute(sql`
      INSERT INTO opportunity_stage_history
        (id, opportunity_id, org_id, from_stage, to_stage,
         transitioned_at, transitioned_by_user_id, transition_reason)
      SELECT
        'sh_' || gen_random_uuid()::text,
        id, org_id, 'Identified', 'Closed-No Action',
        now(), NULL, 'AUTO_EXPIRE_TTL'
      FROM opportunities
      WHERE status = 'expired' AND expiry_reason = 'ttl'
        AND id IN (${sql.join(
          ttlRes.rows!.map((r) => sql`${r.id}`),
          sql`, `,
        )})
    `);
  }

  // Quiet-cycles sweep — needs the per-org Nth-most-recent completed
  // cycle's `completed_at` so we issue one UPDATE per org. The
  // correlated subquery uses LIMIT 1 OFFSET (quietCycles - 1) on the
  // per-org cycles index, which is cheap.
  const orgs = await db
    .select({ id: orgsTable.id })
    .from(orgsTable);
  let quietCyclesExpired = 0;
  let orgsScanned = 0;
  for (const org of orgs) {
    orgsScanned += 1;
    const offset = quietCycles - 1;
    const res = await db.execute<{ id: string }>(sql`
      UPDATE opportunities
      SET status = 'expired',
          expiry_reason = 'quiet_cycles',
          canonical_stage = 'Closed-No Action',
          savings_type = 'Identified',
          stage_entered_at = now()
      WHERE org_id = ${org.id}
        AND status = 'proposed'
        AND last_seen_at IS NOT NULL
        AND last_seen_at < (
          SELECT completed_at
          FROM analysis_cycles
          WHERE org_id = ${org.id}
            AND status = 'completed'
            AND completed_at IS NOT NULL
          ORDER BY generation DESC
          OFFSET ${offset}
          LIMIT 1
        )
      RETURNING id
    `);
    const expiredCount = res.rows?.length ?? 0;
    if (expiredCount > 0) {
      await db.execute(sql`
        INSERT INTO opportunity_stage_history
          (id, opportunity_id, org_id, from_stage, to_stage,
           transitioned_at, transitioned_by_user_id, transition_reason)
        SELECT
          'sh_' || gen_random_uuid()::text,
          id, org_id, 'Identified', 'Closed-No Action',
          now(), NULL, 'AUTO_EXPIRE_QUIET_CYCLES'
        FROM opportunities
        WHERE id IN (${sql.join(
          res.rows!.map((r) => sql`${r.id}`),
          sql`, `,
        )})
      `);
    }
    quietCyclesExpired += expiredCount;
  }

  const totalExpired = ttlExpired + quietCyclesExpired;
  if (totalExpired > 0) {
    logger.info(
      {
        orgsScanned,
        ttlExpired,
        quietCyclesExpired,
        totalExpired,
        ttlDays,
        quietCycles,
      },
      "Auto-expired stale opportunities",
    );
  }

  return {
    orgsScanned,
    ttlExpired,
    quietCyclesExpired,
    totalExpired,
    ttlDays,
    quietCycles,
  };
}

/**
 * Enqueue exactly one `expire_stale_opportunities` job iff there is
 * not already one pending or running. Same advisory-lock-protected
 * shape as the prune schedulers above.
 */
export async function ensureExpireStaleOpportunitiesScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${EXPIRE_STALE_OPPS_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'expire_stale_opportunities' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) return;

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'expire_stale_opportunities', NULL, '{}'::jsonb, 'pending')
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

let expireStaleOppsStarted = false;
let expireStaleOppsHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic auto-expire scheduler. Enqueues an
 * `expire_stale_opportunities` job at boot, then again on a fixed
 * interval (default 24h, overridable via
 * `EXPIRE_STALE_OPPS_INTERVAL_MS`). Idempotent — calling twice has
 * no effect.
 */
export function startExpireStaleOpportunitiesScheduler(
  intervalMs?: number,
): void {
  if (expireStaleOppsStarted) return;
  expireStaleOppsStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber(
      "EXPIRE_STALE_OPPS_INTERVAL_MS",
      DEFAULT_EXPIRE_STALE_OPPS_INTERVAL_MS,
    );

  void ensureExpireStaleOpportunitiesScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial expire_stale_opportunities",
    );
  });

  expireStaleOppsHandle = setInterval(() => {
    ensureExpireStaleOpportunitiesScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled expire_stale_opportunities",
      );
    });
  }, ms);
}

export function stopExpireStaleOpportunitiesScheduler(): void {
  if (expireStaleOppsHandle) clearInterval(expireStaleOppsHandle);
  expireStaleOppsHandle = null;
  expireStaleOppsStarted = false;
}

// ─── Auto-clear expired snoozes (task #228) ──────────────────────────────
//
// Display has always honoured the deadline via the
// `snoozed_until IS NULL OR snoozed_until <= now()` SQL filter, so a
// row whose deadline has passed already reappears in lists. But the
// `snoozed_until` column itself is never cleared by that filter, so
// rows pile up forever with stale past timestamps. This clutters
// audit queries and makes naive reporting ("how many rows are
// currently snoozed?") wrong.
//
// This sweep runs hourly, NULLs out every `snoozed_until` whose
// deadline is in the past, and writes one synthetic
// `unsnooze` decision per affected row with `actor='system'` so the
// audit trail records the auto-clear the same way an operator-driven
// unsnooze would. The UPDATE is naturally idempotent — once a row
// has been cleared it no longer matches the WHERE clause.

const CLEAR_EXPIRED_SNOOZES_LOCK_KEY = 0x53444a4c; // "SDJL" — stale-snooze
const DEFAULT_CLEAR_EXPIRED_SNOOZES_INTERVAL_MS = 60 * 60 * 1000; // 1h

export interface ClearExpiredSnoozesResult {
  /** Number of opportunity rows whose `snoozed_until` was NULLed. */
  cleared: number;
  /**
   * Number of `unsnooze` decision rows successfully written for the
   * cleared rows. Equal to `cleared` on the happy path; lower if the
   * audit insert failed (the sweep itself still committed — audit
   * loss is logged but does not fail the job).
   */
  decisionsWritten: number;
}

/**
 * Single sweep: clears every `snoozed_until` whose deadline is in the
 * past and writes a `unsnooze` decision row per affected opportunity
 * with `actor='system'`.
 *
 * Cleared rows that lack a `cycle_id` (legacy) fall back to the same
 * synthetic `"unknown"` marker the bulk-snooze/unsnooze routes use,
 * because `decisions.cycle_id` is `NOT NULL` and we never want the
 * audit insert to blow up on a NOT NULL violation.
 */
export async function clearExpiredSnoozes(): Promise<ClearExpiredSnoozesResult> {
  const res = await db.execute(sql`
    UPDATE opportunities
    SET snoozed_until = NULL
    WHERE snoozed_until IS NOT NULL
      AND snoozed_until <= now()
    RETURNING id, org_id, cycle_id
  `);
  const rows = (res.rows ?? []) as Array<{
    id: string;
    org_id: string;
    cycle_id: string | null;
  }>;

  if (rows.length === 0) {
    return { cleared: 0, decisionsWritten: 0 };
  }

  const decisionValues = rows.map((r) => ({
    id: newId("dec"),
    orgId: r.org_id,
    opportunityId: r.id,
    // `decisions.cycle_id` is NOT NULL; legacy rows that somehow lack
    // a cycle pointer get the same synthetic "unknown" marker the
    // bulk-snooze/unsnooze routes use.
    cycleId: r.cycle_id ?? "unknown",
    eventType: "unsnooze" as const,
    actor: "system",
  }));

  let decisionsWritten = 0;
  try {
    await db.insert(decisionsTable).values(decisionValues);
    decisionsWritten = decisionValues.length;
  } catch (err) {
    // Audit insert failure must NOT fail the job — the snoozed_until
    // clear has already committed and re-running the sweep cannot
    // re-discover those rows. Log loudly so operators notice if
    // unsnooze decisions stop appearing on the audit feed.
    logger.warn(
      { err, cleared: rows.length },
      "clear_expired_snoozes: failed to insert system unsnooze decision rows",
    );
  }

  logger.info(
    { cleared: rows.length, decisionsWritten },
    "Auto-cleared expired snoozes",
  );

  return { cleared: rows.length, decisionsWritten };
}

/**
 * Enqueue exactly one `clear_expired_snoozes` job iff there is not
 * already one pending or running. Same advisory-lock-protected shape
 * as the other internal schedulers above.
 */
export async function ensureClearExpiredSnoozesScheduled(): Promise<JobRow | null> {
  const jobId = newId("job");
  let inserted = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${CLEAR_EXPIRED_SNOOZES_LOCK_KEY})`,
    );

    const existing = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'clear_expired_snoozes' AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if ((existing.rows?.length ?? 0) > 0) return;

    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status)
      VALUES (${jobId}, 'clear_expired_snoozes', NULL, '{}'::jsonb, 'pending')
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

let clearExpiredSnoozesStarted = false;
let clearExpiredSnoozesHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic snooze-clear scheduler. Enqueues a
 * `clear_expired_snoozes` job at boot, then again on a fixed
 * interval (default 1h, overridable via
 * `CLEAR_EXPIRED_SNOOZES_INTERVAL_MS`). Idempotent — calling twice
 * has no effect.
 */
export function startClearExpiredSnoozesScheduler(
  intervalMs?: number,
): void {
  if (clearExpiredSnoozesStarted) return;
  clearExpiredSnoozesStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber(
      "CLEAR_EXPIRED_SNOOZES_INTERVAL_MS",
      DEFAULT_CLEAR_EXPIRED_SNOOZES_INTERVAL_MS,
    );

  void ensureClearExpiredSnoozesScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial clear_expired_snoozes",
    );
  });

  clearExpiredSnoozesHandle = setInterval(() => {
    ensureClearExpiredSnoozesScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled clear_expired_snoozes",
      );
    });
  }, ms);
}

export function stopClearExpiredSnoozesScheduler(): void {
  if (clearExpiredSnoozesHandle) clearInterval(clearExpiredSnoozesHandle);
  clearExpiredSnoozesHandle = null;
  clearExpiredSnoozesStarted = false;
}

// ─── Per-connection recurring ERP-sync scheduler (task #142) ─────────────
//
// Every operator-installed ERP connection (Coupa today, more adapters
// later) carries a per-row `sync_interval_minutes` cadence and a
// `next_scheduled_sync_at` watermark. This scheduler is the only part
// of the system that turns those two fields into queued work:
//
//   - Tick every `ERP_SYNC_TICK_INTERVAL_MS` (default 60s).
//   - SELECT every active connection whose `next_scheduled_sync_at <=
//     NOW()` (paused / errored connections never auto-fire — operators
//     must intervene).
//   - For each due connection enqueue ONE `sync_erp_connection` job
//     under the per-org advisory lock (`stringHash32(orgId)` sub-key,
//     same namespace as `enqueueJob`) so a parallel manual "Sync now"
//     press cannot race us into double-enqueueing the same connection.
//   - Skip the insert when the org is at the `MAX_PENDING_JOBS_PER_ORG`
//     quota OR another `sync_erp_connection` for the same connection
//     is already pending/running (e.g. operator just clicked Sync now).
//   - In every code path — enqueued, skipped because in-flight,
//     skipped because over-quota — bump
//     `next_scheduled_sync_at = now() + sync_interval_minutes` so the
//     scheduler does not hot-loop on the same row every tick.
//
// Manual "Sync now" via `POST /integrations/connections/:id/sync`
// keeps working unchanged: the route still calls `enqueueJob`
// directly, and the in-flight dedupe in this scheduler observes any
// resulting pending row and treats it as the scheduled run for this
// interval.

const DEFAULT_ERP_SYNC_TICK_INTERVAL_MS = 60_000; // 60s

export interface ErpSyncSchedulerTickResult {
  /** Number of connections inspected this tick (status='active' AND due). */
  scanned: number;
  /** Number of `sync_erp_connection` jobs newly enqueued this tick. */
  enqueued: number;
  /** Connections skipped because a sync was already in-flight or quota was full. */
  skipped: number;
  /** Connections that errored during the per-row enqueue (logged, not thrown). */
  errored: number;
}

/**
 * Single sweep of the recurring ERP-sync scheduler.
 *
 * Exported for tests so they can drive a deterministic tick instead of
 * waiting for the `setInterval` callback. Returns per-tick counters
 * suitable for assertions and for the operator-visible log line.
 */
export async function enqueueDueErpSyncs(): Promise<ErpSyncSchedulerTickResult> {
  const dueRows = await db
    .select({
      id: erpConnectionsTable.id,
      orgId: erpConnectionsTable.orgId,
      syncIntervalMinutes: erpConnectionsTable.syncIntervalMinutes,
      nextScheduledSyncAt: erpConnectionsTable.nextScheduledSyncAt,
      status: erpConnectionsTable.status,
    })
    .from(erpConnectionsTable)
    .where(
      and(
        eq(erpConnectionsTable.status, "active"),
        sql`${erpConnectionsTable.nextScheduledSyncAt} IS NOT NULL`,
        sql`${erpConnectionsTable.nextScheduledSyncAt} <= NOW()`,
      ),
    );

  const result: ErpSyncSchedulerTickResult = {
    scanned: dueRows.length,
    enqueued: 0,
    skipped: 0,
    errored: 0,
  };

  for (const row of dueRows) {
    try {
      const outcome = await enqueueDueErpSyncForConnection(row);
      if (outcome === "enqueued") result.enqueued += 1;
      else result.skipped += 1;
    } catch (err) {
      result.errored += 1;
      logger.error(
        {
          err: (err as Error).message,
          connectionId: row.id,
          orgId: row.orgId,
        },
        "Failed to schedule recurring ERP sync for connection",
      );
    }
  }

  if (result.enqueued > 0 || result.errored > 0) {
    logger.info(
      result as unknown as Record<string, unknown>,
      "ERP sync scheduler tick",
    );
  }
  return result;
}

type EnqueueOutcome = "enqueued" | "skipped";

/**
 * Per-connection enqueue + watermark bump under a per-org advisory
 * lock. Re-reads the connection inside the transaction so a concurrent
 * PATCH that pauses the connection or shifts the cadence cannot race
 * with the scheduler.
 */
async function enqueueDueErpSyncForConnection(row: {
  id: string;
  orgId: string;
  syncIntervalMinutes: number;
  nextScheduledSyncAt: Date | null;
}): Promise<EnqueueOutcome> {
  const lockKey = stringHash32(row.orgId);
  const maxAttempts = await resolveMaxAttempts(
    "sync_erp_connection",
    row.orgId,
  );

  let outcome: EnqueueOutcome = "skipped";

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${JOB_ENQUEUE_LOCK_NS}, ${lockKey})`,
    );

    // Re-read inside the lock so a concurrent PATCH (pause, cadence
    // change, manual Sync now bumping next_scheduled_sync_at) is
    // observed before we commit.
    const fresh = await tx.execute(sql`
      SELECT id, org_id, status, sync_interval_minutes, next_scheduled_sync_at
      FROM erp_connections
      WHERE id = ${row.id}
      LIMIT 1
    `);
    const f = fresh.rows?.[0] as
      | {
          id: string;
          org_id: string;
          status: string;
          sync_interval_minutes: number;
          next_scheduled_sync_at: string | Date | null;
        }
      | undefined;
    if (!f || f.status !== "active") return;

    const nextDue =
      f.next_scheduled_sync_at instanceof Date
        ? f.next_scheduled_sync_at
        : f.next_scheduled_sync_at
          ? new Date(f.next_scheduled_sync_at)
          : null;
    if (!nextDue || nextDue.getTime() > Date.now()) return;

    // Bump the watermark FIRST so we never hot-loop, regardless of
    // whether the actual enqueue below succeeds.
    const intervalMs = f.sync_interval_minutes * 60_000;
    const newNextAt = new Date(Date.now() + intervalMs);
    await tx.execute(sql`
      UPDATE erp_connections
      SET next_scheduled_sync_at = ${newNextAt.toISOString()},
          updated_at = NOW()
      WHERE id = ${row.id}
    `);

    // Don't enqueue if a sync_erp_connection job for this connection
    // is already pending or running — operator may have just clicked
    // "Sync now", or the previous scheduled run hasn't drained yet.
    const inFlight = await tx.execute(sql`
      SELECT 1 FROM jobs
      WHERE kind = 'sync_erp_connection'
        AND org_id = ${row.orgId}
        AND status IN ('pending', 'running')
        AND payload->>'connectionId' = ${row.id}
      LIMIT 1
    `);
    if ((inFlight.rows?.length ?? 0) > 0) return;

    // Per-org pending+running quota — same MAX_PENDING_JOBS_PER_ORG
    // rule that `enqueueJob` enforces. We must check it here too
    // because we are bypassing `enqueueJob` to keep the watermark
    // bump and the insert in a single transaction.
    const countRes = await tx.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM jobs
      WHERE org_id = ${row.orgId}
        AND status IN ('pending', 'running')
    `);
    const pendingCount = (countRes.rows?.[0] as { n?: number } | undefined)?.n ?? 0;
    if (pendingCount >= MAX_PENDING_JOBS_PER_ORG) return;

    const jobId = newId("job");
    await tx.execute(sql`
      INSERT INTO jobs (id, kind, org_id, payload, status, max_attempts)
      VALUES (
        ${jobId},
        'sync_erp_connection',
        ${row.orgId},
        ${JSON.stringify({ connectionId: row.id })}::jsonb,
        'pending',
        ${maxAttempts}
      )
    `);
    outcome = "enqueued";
  });

  return outcome;
}

let erpSyncSchedulerStarted = false;
let erpSyncSchedulerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the recurring ERP-sync scheduler. Sweeps `erp_connections`
 * every `ERP_SYNC_TICK_INTERVAL_MS` (default 60s, env-overridable)
 * and enqueues `sync_erp_connection` jobs for connections whose
 * `next_scheduled_sync_at` has elapsed. Idempotent — calling twice
 * has no effect.
 */
export function startErpSyncScheduler(intervalMs?: number): void {
  if (erpSyncSchedulerStarted) return;
  erpSyncSchedulerStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber(
      "ERP_SYNC_TICK_INTERVAL_MS",
      DEFAULT_ERP_SYNC_TICK_INTERVAL_MS,
    );

  void enqueueDueErpSyncs().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Initial ERP sync scheduler tick failed",
    );
  });

  erpSyncSchedulerHandle = setInterval(() => {
    enqueueDueErpSyncs().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Scheduled ERP sync scheduler tick failed",
      );
    });
  }, ms);
}

export function stopErpSyncScheduler(): void {
  if (erpSyncSchedulerHandle) clearInterval(erpSyncSchedulerHandle);
  erpSyncSchedulerHandle = null;
  erpSyncSchedulerStarted = false;
}
