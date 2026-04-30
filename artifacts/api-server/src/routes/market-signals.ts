import { Router, type IRouter } from "express";
import {
  db,
  marketSignalsTable,
  marketSignalTypes,
  type MarketSignalType,
} from "@workspace/db";
import { and, asc, desc, eq, gte, isNull, lte, or, type SQL } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";

const router: IRouter = Router();

function parseDateParam(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

router.get("/market-signals", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    5000,
  );

  // Tenant scope: rows tagged with this org OR global (orgId IS NULL) signals
  // such as published commodity indices that are shared across tenants.
  const conditions: SQL[] = [
    or(eq(marketSignalsTable.orgId, orgId), isNull(marketSignalsTable.orgId))!,
  ];

  const signalType = req.query.signalType;
  if (
    typeof signalType === "string" &&
    (marketSignalTypes as readonly string[]).includes(signalType)
  ) {
    conditions.push(
      eq(marketSignalsTable.signalType, signalType as MarketSignalType),
    );
  }

  const scopeMaterialCode = req.query.scopeMaterialCode;
  if (typeof scopeMaterialCode === "string" && scopeMaterialCode.length > 0) {
    conditions.push(
      eq(marketSignalsTable.scopeMaterialCode, scopeMaterialCode),
    );
  }

  const observedAfter = parseDateParam(req.query.observedAfter);
  if (observedAfter) {
    conditions.push(gte(marketSignalsTable.observedAt, observedAfter));
  }
  const observedBefore = parseDateParam(req.query.observedBefore);
  if (observedBefore) {
    conditions.push(lte(marketSignalsTable.observedAt, observedBefore));
  }

  const order = req.query.order === "asc" ? "asc" : "desc";
  const orderBy =
    order === "asc"
      ? asc(marketSignalsTable.observedAt)
      : desc(marketSignalsTable.observedAt);

  const rows = await db
    .select()
    .from(marketSignalsTable)
    .where(and(...conditions))
    .orderBy(orderBy)
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
