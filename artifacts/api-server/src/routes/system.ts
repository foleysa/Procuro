import { Router, type IRouter } from "express";
import { db, jobsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { requirePlatformAdmin } from "../lib/platform-admin";
import {
  ensureFunnelSnapshotPruneJobScheduled,
  ensurePruneJobScheduled,
  getFunnelSnapshotRetentionConfig,
  getJobRetentionConfig,
} from "../lib/jobs/queue";
import { getCsvIngestMetricsSummary } from "../lib/csv-ingest-metrics";

const router: IRouter = Router();

/**
 * Cleanup status — returns the most recent `prune_jobs` row plus the
 * configured retention windows so the System page can show
 * "Last cleanup at <ts>" and the next-due hint.
 *
 * Cross-tenant by design (the pruner has no orgId), so it sits behind
 * the platform-admin guard like other cross-tenant endpoints.
 */
router.get(
  "/system/cleanup/status",
  requirePlatformAdmin,
  async (_req, res) => {
    const [last] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.kind, "prune_jobs"))
      .orderBy(desc(jobsTable.enqueuedAt))
      .limit(1);

    const [active] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.kind, "prune_jobs"),
          sql`${jobsTable.status} IN ('pending', 'running')`,
        ),
      )
      .limit(1);

    const cfg = getJobRetentionConfig();
    res.json({
      lastJob: last
        ? {
            id: last.id,
            status: last.status,
            enqueuedAt: last.enqueuedAt,
            startedAt: last.startedAt,
            completedAt: last.completedAt,
            result: last.result ?? null,
            error: last.error,
          }
        : null,
      activeJobId: active?.id ?? null,
      retention: {
        succeededOlderThanMs: cfg.succeededOlderThanMs,
        failedOlderThanMs: cfg.failedOlderThanMs,
      },
    });
  },
);

/**
 * Run cleanup now — enqueue a `prune_jobs` job (or reuse the in-flight
 * one) so an operator can trigger pruning ad hoc without waiting for
 * the next scheduled tick. Returns 202 with the (new or existing) job
 * id either way.
 */
router.post("/system/cleanup/run", requirePlatformAdmin, async (req, res) => {
  const job = await ensurePruneJobScheduled();
  if (!job) {
    // A prune is already pending or running. Find and return it so the
    // UI can poll it instead of blocking the operator on a no-op.
    const [existing] = await db
      .select({ id: jobsTable.id, status: jobsTable.status })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.kind, "prune_jobs"),
          sql`${jobsTable.status} IN ('pending', 'running')`,
        ),
      )
      .orderBy(desc(jobsTable.enqueuedAt))
      .limit(1);
    res.status(202).json({
      jobId: existing?.id ?? null,
      status: existing?.status ?? "pending",
      reused: true,
    });
    req.log.info(
      { jobId: existing?.id ?? null },
      "Reused in-flight prune_jobs for manual cleanup request",
    );
    return;
  }
  req.log.info({ jobId: job.id }, "Enqueued prune_jobs from manual request");
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    reused: false,
  });
});

/**
 * Funnel-snapshot cleanup status — same shape as `/system/cleanup/status`
 * but for the daily `prune_funnel_snapshots` job. Surfaces the most
 * recent run plus the configured retention windows so the System page
 * can render a parallel "Funnel snapshot cleanup" card without baking
 * funnel-specific knowledge into the generic prune card. Cross-tenant
 * by design — the funnel pruner has no `org_id`.
 */
router.get(
  "/system/cleanup/funnel-snapshots/status",
  requirePlatformAdmin,
  async (_req, res) => {
    const [last] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.kind, "prune_funnel_snapshots"))
      .orderBy(desc(jobsTable.enqueuedAt))
      .limit(1);

    const [active] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.kind, "prune_funnel_snapshots"),
          sql`${jobsTable.status} IN ('pending', 'running')`,
        ),
      )
      .limit(1);

    const cfg = getFunnelSnapshotRetentionConfig();
    res.json({
      lastJob: last
        ? {
            id: last.id,
            status: last.status,
            enqueuedAt: last.enqueuedAt,
            startedAt: last.startedAt,
            completedAt: last.completedAt,
            result: last.result ?? null,
            error: last.error,
          }
        : null,
      activeJobId: active?.id ?? null,
      retention: {
        snapshotsOlderThanMs: cfg.snapshotsOlderThanMs,
        failuresOlderThanMs: cfg.failuresOlderThanMs,
      },
    });
  },
);

/**
 * Run funnel-snapshot cleanup now — enqueues a `prune_funnel_snapshots`
 * job (or returns the in-flight one if a prune is already pending or
 * running) so an operator can trigger pruning ad hoc. Mirrors the
 * `/system/cleanup/run` contract so the UI can reuse the same accepted
 * shape and polling loop.
 */
router.post(
  "/system/cleanup/funnel-snapshots/run",
  requirePlatformAdmin,
  async (req, res) => {
    const job = await ensureFunnelSnapshotPruneJobScheduled();
    if (!job) {
      const [existing] = await db
        .select({ id: jobsTable.id, status: jobsTable.status })
        .from(jobsTable)
        .where(
          and(
            eq(jobsTable.kind, "prune_funnel_snapshots"),
            sql`${jobsTable.status} IN ('pending', 'running')`,
          ),
        )
        .orderBy(desc(jobsTable.enqueuedAt))
        .limit(1);
      res.status(202).json({
        jobId: existing?.id ?? null,
        status: existing?.status ?? "pending",
        reused: true,
      });
      req.log.info(
        { jobId: existing?.id ?? null },
        "Reused in-flight prune_funnel_snapshots for manual cleanup request",
      );
      return;
    }
    req.log.info(
      { jobId: job.id },
      "Enqueued prune_funnel_snapshots from manual request",
    );
    res.status(202).json({
      jobId: job.id,
      status: job.status,
      reused: false,
    });
  },
);

/**
 * CSV ingest throughput metrics — recent runs + per-entity 7-day
 * trend. Powers the "CSV ingest performance" panel on the System
 * page so operators can spot rows/sec drift between deploys without
 * waiting for the CI ceiling tests in `routes/ingest.ts` to fire.
 *
 * Cross-tenant by design (operators look at global throughput drift,
 * not single-tenant numbers), so this sits behind the same
 * platform-admin guard as the cleanup endpoints above.
 */
router.get(
  "/system/csv-ingest/metrics",
  requirePlatformAdmin,
  async (req, res) => {
    const windowDaysRaw = Number(req.query["windowDays"] ?? 7);
    const recentLimitRaw = Number(req.query["recentLimit"] ?? 25);
    const windowDays = Number.isFinite(windowDaysRaw)
      ? Math.max(1, Math.min(30, Math.floor(windowDaysRaw)))
      : 7;
    const recentLimit = Number.isFinite(recentLimitRaw)
      ? Math.max(1, Math.min(200, Math.floor(recentLimitRaw)))
      : 25;
    const summary = await getCsvIngestMetricsSummary({
      windowDays,
      recentLimit,
    });
    res.json(summary);
  },
);

export default router;
