import { Router, type IRouter } from "express";
import {
  db,
  analysisCyclesTable,
  learnedPriorsTable,
  opportunitiesTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { ApiError, NotFoundError } from "../lib/api-errors";
import { ensureOrgAnalysisCycleScheduled } from "../lib/jobs/queue";
import {
  dedupeSources,
  extractSourcesFromInputs,
} from "../lib/insight-sources";

const router: IRouter = Router();

function mapCycle(c: typeof analysisCyclesTable.$inferSelect) {
  return {
    id: c.id,
    orgId: c.orgId,
    generation: c.generation,
    status: c.status,
    triggeredBy: c.triggeredBy,
    opportunitiesCreated: c.opportunitiesCreated,
    totalProjectedUsd: Number(c.totalProjectedUsd),
    startedAt: c.startedAt,
    completedAt: c.completedAt,
  };
}

router.get("/cycles", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rows = await db
    .select()
    .from(analysisCyclesTable)
    .where(eq(analysisCyclesTable.orgId, orgId))
    .orderBy(desc(analysisCyclesTable.generation));
  res.json(rows.map(mapCycle));
});

router.get("/cycles/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const [c] = await db
    .select()
    .from(analysisCyclesTable)
    .where(
      and(
        eq(analysisCyclesTable.orgId, orgId),
        eq(analysisCyclesTable.id, String(req.params.id)),
      ),
    );
  if (!c) {
    throw new NotFoundError("Cycle not found");
  }
  // Aggregate citation sources from every opportunity created during
  // this cycle. The cycle-level citation list lets the OODA panel show
  // a single "backed by" footer instead of per-opportunity strips, so
  // we de-duplicate by collector + URL and keep the most recent
  // observation for each.
  const cycleOpps = await db
    .select({ inputs: opportunitiesTable.inputs })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        eq(opportunitiesTable.cycleId, c.id),
      ),
    );
  const allSources = cycleOpps.flatMap((row) =>
    extractSourcesFromInputs(row.inputs as Record<string, unknown> | null),
  );
  res.json({
    ...mapCycle(c),
    observePayload: c.observePayload ?? {},
    orientPayload: c.orientPayload ?? {},
    decidePayload: c.decidePayload ?? {},
    actPayload: c.actPayload ?? {},
    learnPayload: c.learnPayload ?? {},
    sources: dedupeSources(allSources),
  });
});

/**
 * Run an OODA cycle.
 *
 * All cycle runs are enqueued through `ensureOrgAnalysisCycleScheduled`,
 * which applies the same per-tenant pending+running quota and advisory-lock
 * deduplication used by the scheduled fan-out. This prevents authenticated
 * tenants from bypassing workload controls and monopolising shared API and
 * database resources by calling this endpoint directly or concurrently.
 *
 * The `?async` parameter is accepted for backwards compatibility but is now
 * a no-op — every call returns a 202 with a job id for polling via
 * `/jobs/:id`.
 */
router.post("/cycles/run", tenantMiddleware, requirePermission("ingest:write"), async (req, res) => {
  const orgId = requireOrgId(req);
  const triggeredBy = req.actorEmail ?? "system@procuro.ai";

  // Route through the same race-safe dedupe helper the periodic
  // `analysis_cycle_fanout` handler uses, so a manual "Run now" click
  // overlapping a scheduled fan-out (or a double-click) can never produce
  // two pending `run_analysis_cycle` rows for one org. When dedupe hits,
  // we return the already-in-flight job's id so the UI can poll it just
  // like a freshly-enqueued one.
  const result = await ensureOrgAnalysisCycleScheduled(orgId, {
    payload: { triggeredBy, source: "manual" },
  });

  if (result.enqueued) {
    res.status(202).json({ jobId: result.job.id, status: result.job.status });
    return;
  }
  if (result.reason === "in_flight") {
    res.status(202).json({
      jobId: result.existingJobId,
      status: "in_flight",
      deduped: true,
    });
    return;
  }
  // quota_exceeded
  throw new ApiError(429, "quota_exceeded", "Per-tenant pending+running job quota exceeded");
});

router.get("/priors", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const rows = await db
    .select()
    .from(learnedPriorsTable)
    .where(eq(learnedPriorsTable.orgId, orgId));
  res.json(
    rows.map((r) => ({
      leverId: r.leverId,
      projectionMultiplier: Number(r.projectionMultiplier),
      confidenceWeight: Number(r.confidenceWeight),
      evidenceCount: r.evidenceCount,
      approvalCount: r.approvalCount,
      rejectionCount: r.rejectionCount,
      realizationCount: r.realizationCount,
      updatedAtCycle: r.updatedAtCycle,
    })),
  );
});

export default router;
