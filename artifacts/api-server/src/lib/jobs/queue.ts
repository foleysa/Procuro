import {
  db,
  jobsTable,
  jobKindSettingsTable,
  type JobKind,
  type JobRow,
} from "@workspace/db";
import { eq, and, asc, sql } from "drizzle-orm";
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
  // The pruner is internal housekeeping with no upstream API calls; if a
  // single run trips on a transient DB hiccup it's fine to retry once or
  // twice, but the next scheduled run will catch up regardless, so the
  // default budget of 3 is plenty.
  prune_jobs: 3,
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

  // Atomically transition pending -> failed in one statement so a worker
  // claim cannot race the cancel. Also clear `scheduled_for` so a
  // backoff-rescheduled row that the operator cancels mid-wait doesn't
  // leave a stale next-retry time on the audit trail.
  const pendingResult = await db
    .update(jobsTable)
    .set({
      status: "failed",
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
      await failJob(job.id, new Error(CANCELLED_ERROR_MESSAGE));
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
      await failJob(job.id, new Error(CANCELLED_ERROR_MESSAGE));
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
          attempt: job.attempts,
          maxAttempts: budget,
          retryInMs: delay,
          nextAttemptAt: next.toISOString(),
          err: e.message,
        },
        "Job failed transiently; scheduled for retry",
      );
    } else {
      logger.error(
        {
          jobId: job.id,
          kind: job.kind,
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
const DEFAULT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

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
  succeededOlderThanMs: number;
  failedOlderThanMs: number;
}

/**
 * Delete completed jobs older than the configured retention windows.
 * Always uses `completed_at` (never `enqueued_at`) so a long-running job
 * isn't deleted out from under the worker. Leaves `pending` and `running`
 * jobs untouched.
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

  const succeededDeleted = succeededRes.rows?.length ?? 0;
  const failedDeleted = failedRes.rows?.length ?? 0;

  if (succeededDeleted > 0 || failedDeleted > 0) {
    logger.info(
      {
        succeededDeleted,
        failedDeleted,
        succeededOlderThanMs,
        failedOlderThanMs,
      },
      "Pruned old jobs",
    );
  }

  return {
    succeededDeleted,
    failedDeleted,
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

let prunerStarted = false;
let prunerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic job-pruner scheduler. Enqueues a `prune_jobs` job
 * immediately at startup, then again on a fixed interval (default 6h,
 * overridable via `JOB_PRUNE_INTERVAL_MS`). Idempotent — calling twice
 * has no effect.
 */
export function startJobPruner(intervalMs?: number): void {
  if (prunerStarted) return;
  prunerStarted = true;
  const ms =
    intervalMs ??
    envPositiveNumber("JOB_PRUNE_INTERVAL_MS", DEFAULT_PRUNE_INTERVAL_MS);

  // Run once at startup so the first prune happens promptly after boot
  // even if the interval is long.
  void ensurePruneJobScheduled().catch((err) => {
    logger.error(
      { err: (err as Error).message },
      "Failed to enqueue initial prune_jobs",
    );
  });

  prunerHandle = setInterval(() => {
    ensurePruneJobScheduled().catch((err) => {
      logger.error(
        { err: (err as Error).message },
        "Failed to enqueue scheduled prune_jobs",
      );
    });
  }, ms);
}

export function stopJobPruner(): void {
  if (prunerHandle) clearInterval(prunerHandle);
  prunerHandle = null;
  prunerStarted = false;
}
