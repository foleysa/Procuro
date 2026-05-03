import { Router, type IRouter } from "express";
import {
  db,
  jobsTable,
  orgsTable,
  suppliersTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { requirePlatformAdmin } from "../lib/platform-admin";
import {
  ensureFunnelSnapshotPruneJobScheduled,
  ensurePruneJobScheduled,
  getFunnelSnapshotRetentionSettings,
  getJobPruneSchedule,
  getJobRetentionConfig,
  getNextJobPruneRunAt,
  parsePruneCron,
  setFunnelSnapshotRetentionSettings,
  setJobPruneSchedule,
} from "../lib/jobs/queue";
import {
  getCsvIngestMetricsSummary,
  getCsvJobThroughputHistory,
} from "../lib/csv-ingest-metrics";

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

    const settings = await getFunnelSnapshotRetentionSettings();
    const DAY_MS = 24 * 60 * 60 * 1000;
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
        snapshotsOlderThanMs: settings.snapshotDays * DAY_MS,
        failuresOlderThanMs: settings.failureDays * DAY_MS,
      },
    });
  },
);

/**
 * Read the funnel-snapshot retention windows + audit metadata. Mirrors
 * `/system/job-kind-settings` and `/system/cleanup/schedule` so the
 * System page renders the same "default vs override" UX next to the
 * Funnel snapshot cleanup card. Cross-tenant — gated by the
 * platform-admin token.
 */
router.get(
  "/system/cleanup/funnel-snapshots/retention",
  requirePlatformAdmin,
  async (_req, res) => {
    const settings = await getFunnelSnapshotRetentionSettings();
    res.json({
      snapshotDays: settings.snapshotDays,
      failureDays: settings.failureDays,
      defaultSnapshotDays: settings.defaultSnapshotDays,
      defaultFailureDays: settings.defaultFailureDays,
      isOverride: settings.isOverride,
      lastChangedAt: settings.lastChangedAt
        ? settings.lastChangedAt.toISOString()
        : null,
      lastChangedBy: settings.lastChangedBy,
    });
  },
);

/**
 * Update the funnel-snapshot retention windows. Both fields are
 * required positive-integer day counts (1–3650). Persists to
 * `app_settings` via `setFunnelSnapshotRetentionSettings`; the next
 * `prune_funnel_snapshots` run picks the value up automatically (the
 * pruner reads the cutoffs at execution time, not at scheduler
 * arming, so no in-process timer reload is needed).
 */
router.put(
  "/system/cleanup/funnel-snapshots/retention",
  requirePlatformAdmin,
  async (req, res) => {
    const body = (req.body ?? {}) as {
      snapshotDays?: unknown;
      failureDays?: unknown;
    };
    const snapRaw = body.snapshotDays;
    const failRaw = body.failureDays;
    if (typeof snapRaw !== "number" || typeof failRaw !== "number") {
      res.status(400).json({
        error:
          "Body must include numeric `snapshotDays` and `failureDays` fields",
      });
      return;
    }
    try {
      const actor = req.actorEmail ?? "system@procuro.ai";
      const updated = await setFunnelSnapshotRetentionSettings({
        snapshotDays: snapRaw,
        failureDays: failRaw,
        actorEmail: actor,
      });
      req.log.info(
        {
          snapshotDays: updated.snapshotDays,
          failureDays: updated.failureDays,
          actor,
        },
        "Operator updated funnel_snapshot_retention",
      );
      res.json({
        snapshotDays: updated.snapshotDays,
        failureDays: updated.failureDays,
        defaultSnapshotDays: updated.defaultSnapshotDays,
        defaultFailureDays: updated.defaultFailureDays,
        isOverride: updated.isOverride,
        lastChangedAt: updated.lastChangedAt
          ? updated.lastChangedAt.toISOString()
          : null,
        lastChangedBy: updated.lastChangedBy,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
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
 * Job-prune schedule — read the cron expression that drives the
 * periodic `prune_jobs` scheduler plus the next computed run time.
 *
 * Returned shape includes the in-code default (see
 * `DEFAULT_JOB_PRUNE_CRON`) and the audit metadata (`lastChangedBy`
 * / `lastChangedAt`) so the System page can render the default
 * alongside the operator override and surface who last touched it.
 *
 * Cross-tenant by design — same platform-admin guard as the rest of
 * the cleanup endpoints.
 */
router.get(
  "/system/cleanup/schedule",
  requirePlatformAdmin,
  async (_req, res) => {
    const schedule = await getJobPruneSchedule();
    const nextRunAt = await getNextJobPruneRunAt();
    res.json({
      cron: schedule.cron,
      defaultCron: schedule.defaultCron,
      isOverride: schedule.isOverride,
      nextRunAt: nextRunAt.toISOString(),
      lastChangedAt: schedule.lastChangedAt
        ? schedule.lastChangedAt.toISOString()
        : null,
      lastChangedBy: schedule.lastChangedBy,
    });
  },
);

/**
 * Update the job-prune cron schedule. Validates the cron up-front
 * (rejects with 400 + a human-readable message), writes it to
 * `app_settings`, and reloads the in-process timer so the change
 * takes effect immediately without a server restart. Returns the
 * same shape as GET so the client can refresh its cache from the
 * mutation response.
 */
router.put(
  "/system/cleanup/schedule",
  requirePlatformAdmin,
  async (req, res) => {
    const body = (req.body ?? {}) as { cron?: unknown };
    const cronRaw = body.cron;
    if (typeof cronRaw !== "string") {
      res.status(400).json({ error: "Body must include a `cron` string" });
      return;
    }
    try {
      parsePruneCron(cronRaw);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const actor = req.actorEmail ?? "system@procuro.ai";
    const updated = await setJobPruneSchedule({
      cron: cronRaw.trim(),
      actorEmail: actor,
    });
    const nextRunAt = await getNextJobPruneRunAt();
    req.log.info(
      { cron: updated.cron, actor },
      "Operator updated job_prune_schedule",
    );
    res.json({
      cron: updated.cron,
      defaultCron: updated.defaultCron,
      isOverride: updated.isOverride,
      nextRunAt: nextRunAt.toISOString(),
      lastChangedAt: updated.lastChangedAt
        ? updated.lastChangedAt.toISOString()
        : null,
      lastChangedBy: updated.lastChangedBy,
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

/**
 * CSV ingest throughput history (#157) — hourly p50/p95 latency +
 * rows/sec rollups over a rolling N-hour window. Powers the inline
 * sparkline on the System page's "CSV ingest throughput" card so an
 * operator can see e.g. a slow database evening at a glance instead
 * of scraping logs.
 *
 * Reads `ingest_csv` job rows directly so the chart's data source
 * matches the existing aggregate p50/p95 numbers it sits next to;
 * see `getCsvJobThroughputHistory` for the bucketing rationale.
 *
 * Cross-tenant by design (operators look at global throughput drift,
 * not single-tenant numbers), so this sits behind the same
 * platform-admin guard as the other system endpoints above.
 */
router.get(
  "/system/csv-throughput",
  requirePlatformAdmin,
  async (req, res) => {
    const windowHoursRaw = Number(req.query["windowHours"] ?? 24);
    const windowHours = Number.isFinite(windowHoursRaw)
      ? Math.max(1, Math.min(7 * 24, Math.floor(windowHoursRaw)))
      : 24;
    const history = await getCsvJobThroughputHistory({ windowHours });
    res.json(history);
  },
);

/**
 * Supplier-entity resolver coverage. Counts how many `suppliers` rows
 * have a non-null `entity_uid` populated by the
 * `backfill-supplier-entity-uid` script (or future inline-resolve
 * writers) — both globally and per tenant.
 *
 * The supplier-intelligence read path joins on `metadata.entityUid`
 * when this column is set and skips the `scope_supplier_name` ilike
 * fallback entirely, so this number is the operator's signal for
 * "are we still relying on fuzzy name matching to surface sanctions
 * and corporate filings on the supplier page?".
 *
 * Cross-tenant by design (operators evaluate global rollout state
 * and target the backfill at the worst-covered tenants), so this
 * sits behind the same platform-admin guard as the cleanup endpoints.
 */
router.get(
  "/system/entity-resolution/coverage",
  requirePlatformAdmin,
  async (_req, res) => {
    // Single-pass tenant rollup. Left-joining `suppliers` to `orgs`
    // would suppress orgs with zero suppliers; we don't care about
    // those for coverage, so the inner join over `suppliers` is the
    // right shape. `count(entity_uid)` excludes nulls, giving the
    // resolved count directly without a `FILTER` clause.
    const tenantRows = await db
      .select({
        orgId: suppliersTable.orgId,
        orgName: orgsTable.name,
        totalSuppliers: sql<number>`count(*)::int`,
        resolvedSuppliers: sql<number>`count(${suppliersTable.entityUid})::int`,
      })
      .from(suppliersTable)
      .innerJoin(orgsTable, eq(orgsTable.id, suppliersTable.orgId))
      .groupBy(suppliersTable.orgId, orgsTable.name)
      .orderBy(desc(sql`count(*)`));

    let totalSuppliers = 0;
    let resolvedSuppliers = 0;
    const tenants = tenantRows.map((r) => {
      totalSuppliers += r.totalSuppliers;
      resolvedSuppliers += r.resolvedSuppliers;
      const pct =
        r.totalSuppliers > 0
          ? Math.round((r.resolvedSuppliers / r.totalSuppliers) * 1000) / 10
          : 0;
      return {
        orgId: r.orgId,
        orgName: r.orgName,
        totalSuppliers: r.totalSuppliers,
        resolvedSuppliers: r.resolvedSuppliers,
        coveragePercent: pct,
      };
    });

    const coveragePercent =
      totalSuppliers > 0
        ? Math.round((resolvedSuppliers / totalSuppliers) * 1000) / 10
        : 0;

    res.json({
      totalSuppliers,
      resolvedSuppliers,
      coveragePercent,
      tenants,
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
