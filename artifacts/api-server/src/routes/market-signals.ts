import { Router, type IRouter } from "express";
import { db, marketSignalsTable } from "@workspace/db";
import { desc, eq, isNull, or } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";

const router: IRouter = Router();

router.get("/market-signals", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    200,
  );
  // Tenant scope: rows tagged with this org OR global (orgId IS NULL) signals
  // such as published commodity indices that are shared across tenants.
  const rows = await db
    .select()
    .from(marketSignalsTable)
    .where(
      or(eq(marketSignalsTable.orgId, orgId), isNull(marketSignalsTable.orgId)),
    )
    .orderBy(desc(marketSignalsTable.observedAt))
    .limit(limit);
  res.json(
    rows.map((r) => ({
      id: r.id,
      collectorId: r.collectorId,
      signalType: r.signalType,
      scopeMaterialCode: r.scopeMaterialCode,
      scopeCategoryId: null,
      scopeSupplierId: null,
      value: Number(r.value),
      unit: r.unit,
      currency: r.currency,
      confidence: r.confidence !== null ? Number(r.confidence) : null,
      observedAt: r.observedAt,
      sourceUrl: r.sourceUrl,
    })),
  );
});

export default router;
