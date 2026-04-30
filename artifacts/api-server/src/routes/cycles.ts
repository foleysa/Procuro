import { Router, type IRouter } from "express";
import {
  db,
  analysisCyclesTable,
  learnedPriorsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { runAnalysisCycle } from "../lib/ooda/cycle";
import { enqueueJob } from "../lib/jobs/queue";

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
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  res.json({
    ...mapCycle(c),
    observePayload: c.observePayload ?? {},
    orientPayload: c.orientPayload ?? {},
    decidePayload: c.decidePayload ?? {},
    actPayload: c.actPayload ?? {},
    learnPayload: c.learnPayload ?? {},
  });
});

/**
 * Run an OODA cycle.
 *
 * Default behaviour is synchronous (suitable for the demo seed dataset).
 * For real-world / F500 scale, pass `?async=true` to enqueue the run on the
 * background job queue and return a `jobId` for polling via `/jobs/:id`.
 */
router.post("/cycles/run", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const triggeredBy = req.actorEmail ?? "system@procuro.ai";
  const isAsync =
    req.query["async"] === "true" || req.query["async"] === "1";

  if (isAsync) {
    const job = await enqueueJob({
      kind: "run_analysis_cycle",
      orgId,
      payload: { triggeredBy },
    });
    res.status(202).json({ jobId: job.id, status: job.status });
    return;
  }

  const result = await runAnalysisCycle({ orgId, triggeredBy });
  res.json({
    cycleId: result.cycleId,
    generation: result.generation,
    opportunitiesCreated: result.opportunitiesCreated,
    totalProjectedUsd: result.totalProjectedUsd,
    priorDeltas: result.priorDeltas,
  });
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
