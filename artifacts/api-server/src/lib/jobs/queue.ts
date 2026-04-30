import { db, jobsTable, type JobKind, type JobRow } from "@workspace/db";
import { eq, and, asc, sql } from "drizzle-orm";
import { newId } from "../ids";
import { logger } from "../logger";

export type JobHandler = (job: JobRow) => Promise<Record<string, unknown>>;

const handlers = new Map<JobKind, JobHandler>();

export function registerJobHandler(kind: JobKind, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export async function enqueueJob(args: {
  kind: JobKind;
  orgId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<JobRow> {
  const [row] = await db
    .insert(jobsTable)
    .values({
      id: newId("job"),
      kind: args.kind,
      orgId: args.orgId ?? null,
      payload: args.payload ?? {},
      status: "pending",
    })
    .returning();
  if (!row) throw new Error("Failed to enqueue job");
  return row;
}

export async function claimNextJob(): Promise<JobRow | null> {
  // Atomic claim of the oldest pending job per-tenant fairness via SKIP LOCKED.
  const result = await db.execute(sql`
    UPDATE jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'pending'
      ORDER BY enqueued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
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
