import { db, jobsTable, type JobKind, type JobRow } from "@workspace/db";
import { eq, and, asc, sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";

export type JobHandler = (job: JobRow) => Promise<Record<string, unknown>>;

const handlers = new Map<JobKind, JobHandler>();

/** Maximum number of pending+running jobs a single org may have at once. */
const MAX_PENDING_JOBS_PER_ORG = 5;

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
}): Promise<JobRow> {
  const orgId = args.orgId ?? null;
  const jobId = newId("job");
  const kind = args.kind;
  const payload = args.payload ?? {};

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
        INSERT INTO jobs (id, kind, org_id, payload, status)
        VALUES (${jobId}, ${kind}, ${orgId}, ${JSON.stringify(payload)}::jsonb, 'pending')
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
  const result = await db.execute(sql`
    WITH candidate AS MATERIALIZED (
      SELECT id
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY enqueued_at ASC) AS rn,
               MIN(enqueued_at) OVER (PARTITION BY org_id) AS org_earliest
        FROM jobs
        WHERE status = 'pending'
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
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
    SET status = 'running', started_at = NOW(), attempts = attempts + 1
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
    })
    .where(eq(jobsTable.id, jobId));
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
    await failJob(job.id, new Error(`No handler registered for kind=${job.kind}`));
    return true;
  }
  try {
    const result = await handler(job);
    await completeJob(job.id, result);
    logger.info({ jobId: job.id, kind: job.kind }, "Job succeeded");
  } catch (err) {
    const e = err as Error;
    logger.error({ jobId: job.id, kind: job.kind, err: e.message }, "Job failed");
    await failJob(job.id, e);
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
