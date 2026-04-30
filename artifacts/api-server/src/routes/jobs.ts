import { Router, type IRouter } from "express";
import { db, jobsTable, type JobKind, type JobStatus } from "@workspace/db";
import { and, desc, eq, isNull, or, type SQL } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { enqueueJob } from "../lib/jobs/queue";

const router: IRouter = Router();

const jobKindAllow = new Set<JobKind>([
  "run_analysis_cycle",
  "ingest_csv",
  "ingest_mock_erp",
  "run_collector",
]);

const jobStatusAllow = new Set<JobStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
]);

function mapJob(r: typeof jobsTable.$inferSelect) {
  return {
    id: r.id,
    orgId: r.orgId,
    kind: r.kind,
    status: r.status,
    attempts: r.attempts,
    progress: r.progress,
    result: r.result ?? null,
    error: r.error,
    enqueuedAt: r.enqueuedAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  };
}

router.get("/jobs", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt((req.query["limit"] as string) ?? "50", 10) || 50, 1),
    200,
  );

  const filters: SQL[] = [
    or(eq(jobsTable.orgId, orgId), isNull(jobsTable.orgId)) as SQL,
  ];

  const kindParam = req.query["kind"];
  if (typeof kindParam === "string" && jobKindAllow.has(kindParam as JobKind)) {
    filters.push(eq(jobsTable.kind, kindParam as JobKind));
  }
  const statusParam = req.query["status"];
  if (
    typeof statusParam === "string" &&
    jobStatusAllow.has(statusParam as JobStatus)
  ) {
    filters.push(eq(jobsTable.status, statusParam as JobStatus));
  }

  const rows = await db
    .select()
    .from(jobsTable)
    .where(and(...filters))
    .orderBy(desc(jobsTable.enqueuedAt))
    .limit(limit);

  res.json(rows.map(mapJob));
});

router.get("/jobs/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, String(req.params.id)),
        or(eq(jobsTable.orgId, orgId), isNull(jobsTable.orgId)),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(mapJob(row));
});

router.post("/jobs/:id/retry", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const [row] = await db
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.id, String(req.params.id)),
        or(eq(jobsTable.orgId, orgId), isNull(jobsTable.orgId)),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (row.status !== "failed") {
    res.status(409).json({
      error: `Only failed jobs can be retried (current status: ${row.status})`,
    });
    return;
  }

  const job = await enqueueJob({
    kind: row.kind,
    orgId: row.orgId,
    payload: row.payload ?? {},
  });
  req.log.info(
    { originalJobId: row.id, retryJobId: job.id, kind: job.kind },
    "Retried failed job",
  );
  res.status(202).json({ jobId: job.id, status: job.status });
});

export default router;
