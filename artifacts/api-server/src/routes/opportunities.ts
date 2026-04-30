import { Router, type IRouter } from "express";
import {
  db,
  opportunitiesTable,
  decisionsTable,
  suppliersTable,
  categoriesTable,
  rejectionReasonCodes,
  type LeverId,
  type OpportunityStatus,
} from "@workspace/db";
import { and, eq, desc, sql, or, lt } from "drizzle-orm";
import { z } from "zod";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { newId } from "../lib/ids";
import { extractSourcesFromInputs } from "../lib/insight-sources";

const router: IRouter = Router();

// Body schemas for the action endpoints. Defined at module scope so the
// validation tests can import them directly and share the exact shape
// the production routes ship with. The two routes call `.parse(...)`
// and rely on the global error handler to map any thrown `ZodError`
// to `400 { error, details }` (see `lib/global-error-handler.ts`),
// matching the wire shape the collectors routes use after task #92.
export const rejectOpportunityBodySchema = z.object({
  reasonCode: z.enum(rejectionReasonCodes),
  // Preserve the previous `asOptionalString` semantics: missing,
  // null, or empty-string values all collapse to `null` so the DB
  // column stores a single canonical "no note" form.
  reasonText: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" && v.length > 0 ? v : null)),
});

export const realizeOpportunityBodySchema = z.object({
  // Preserve the previous `asNumber` semantics exactly:
  //   - JSON numbers must be finite (no NaN/Infinity).
  //   - Numeric strings (e.g. `"123.45"`) are accepted, but the empty
  //     string is rejected — naive `z.coerce.number()` would silently
  //     turn `""` into `0` and record a phantom realized-savings value
  //     on this state-changing endpoint, which the old hand-rolled
  //     validator explicitly guarded against (`v.length > 0`).
  realizedSavingsUsd: z.union([
    z.number().finite(),
    z
      .string()
      .min(1)
      .transform((s, ctx) => {
        const n = Number(s);
        if (!Number.isFinite(n)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Expected a finite number",
          });
          return z.NEVER;
        }
        return n;
      }),
  ]),
});

// Single SQL pass: refresh cycle counters + actPayload after a status change.
async function updateCycleAggregates(
  orgId: string,
  cycleId: string | null,
): Promise<void> {
  if (!cycleId) return;
  await db.execute(sql`
    WITH cnt AS (
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('approved', 'executing', 'realized')
        )::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE status = 'realized')::int AS realized,
        COALESCE(
          SUM(realized_savings_usd) FILTER (WHERE status = 'realized'),
          0
        )::numeric(18, 2) AS realized_usd
      FROM opportunities
      WHERE org_id = ${orgId} AND cycle_id = ${cycleId}
    )
    UPDATE analysis_cycles
    SET
      opportunities_approved = cnt.approved,
      opportunities_rejected = cnt.rejected,
      opportunities_realized = cnt.realized,
      total_realized_usd = cnt.realized_usd,
      act_payload = jsonb_set(
        jsonb_set(
          COALESCE(act_payload, '{}'::jsonb),
          '{decisionCounts}',
          jsonb_build_object(
            'approved', cnt.approved,
            'rejected', cnt.rejected,
            'realized', cnt.realized,
            'totalRealizedUsd', cnt.realized_usd
          ),
          true
        ),
        '{lastUpdatedAt}',
        to_jsonb(now()),
        true
      )
    FROM cnt
    WHERE analysis_cycles.id = ${cycleId}
      AND analysis_cycles.org_id = ${orgId};
  `);
}

function mapOpportunity(row: {
  opp: typeof opportunitiesTable.$inferSelect;
  supplierName?: string | null;
  categoryName?: string | null;
}) {
  const o = row.opp;
  return {
    id: o.id,
    orgId: o.orgId,
    cycleId: o.cycleId,
    leverId: o.leverId,
    tier: o.tier,
    status: o.status,
    title: o.title,
    rationale: o.rationale,
    recommendedAction: o.recommendedAction,
    supplierId: o.supplierId,
    supplierName: row.supplierName ?? null,
    categoryId: o.categoryId,
    categoryName: row.categoryName ?? null,
    rawProjectedSavingsUsd: Number(o.rawProjectedSavingsUsd),
    projectedSavingsUsd: Number(o.projectedSavingsUsd),
    confidence: Number(o.confidence),
    realizedSavingsUsd: Number(o.realizedSavingsUsd),
    rejectedReasonCode: o.rejectedReasonCode,
    rejectedReasonText: o.rejectedReasonNote,
    realizedAt: o.realizedAt,
    createdAt: o.createdAt,
  };
}

router.get("/opportunities", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const status = req.query.status as OpportunityStatus | undefined;
  const leverId = req.query.leverId as LeverId | undefined;
  const cycleId = req.query.cycleId as string | undefined;
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "100", 10) || 100, 1),
    200,
  );
  const cursor = req.query.cursor as string | undefined;

  // Composite (projectedSavingsUsd DESC, id ASC) keyset pagination — cursor
  // encodes both columns so paging is stable when many rows share a savings
  // value (which the projected_savings_usd numeric column allows).
  const where = [eq(opportunitiesTable.orgId, orgId)];
  if (status) where.push(eq(opportunitiesTable.status, status));
  if (leverId) where.push(eq(opportunitiesTable.leverId, leverId));
  if (cycleId) where.push(eq(opportunitiesTable.cycleId, cycleId));
  if (cursor) {
    const decoded = decodeOppCursor(cursor);
    if (decoded) {
      const { savings, id } = decoded;
      const cond = or(
        lt(opportunitiesTable.projectedSavingsUsd, savings),
        and(
          eq(opportunitiesTable.projectedSavingsUsd, savings),
          sql`${opportunitiesTable.id} > ${id}`,
        ),
      );
      if (cond) where.push(cond);
    }
  }

  const rows = await db
    .select({
      opp: opportunitiesTable,
      supplierName: suppliersTable.name,
      categoryName: categoriesTable.name,
    })
    .from(opportunitiesTable)
    .leftJoin(
      suppliersTable,
      eq(opportunitiesTable.supplierId, suppliersTable.id),
    )
    .leftJoin(
      categoriesTable,
      eq(opportunitiesTable.categoryId, categoriesTable.id),
    )
    .where(and(...where))
    .orderBy(
      desc(opportunitiesTable.projectedSavingsUsd),
      sql`${opportunitiesTable.id} ASC`,
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const items = sliced.map(mapOpportunity);
  const last = sliced.at(-1);
  res.json({
    items,
    nextCursor:
      hasMore && last
        ? encodeOppCursor(last.opp.projectedSavingsUsd, last.opp.id)
        : null,
  });
});

function encodeOppCursor(savings: string, id: string): string {
  return Buffer.from(`${savings}|${id}`, "utf8").toString("base64url");
}
function decodeOppCursor(
  raw: string,
): { savings: string; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep <= 0) return null;
    const savings = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!savings || !id || Number.isNaN(Number(savings))) return null;
    return { savings, id };
  } catch {
    return null;
  }
}

router.get("/opportunities/:id", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const [row] = await db
    .select({
      opp: opportunitiesTable,
      supplierName: suppliersTable.name,
      categoryName: categoriesTable.name,
    })
    .from(opportunitiesTable)
    .leftJoin(
      suppliersTable,
      eq(opportunitiesTable.supplierId, suppliersTable.id),
    )
    .leftJoin(
      categoriesTable,
      eq(opportunitiesTable.categoryId, categoriesTable.id),
    )
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        eq(opportunitiesTable.id, id),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  const decisions = await db
    .select()
    .from(decisionsTable)
    .where(eq(decisionsTable.opportunityId, id))
    .orderBy(desc(decisionsTable.createdAt));
  const inputs = (row.opp.inputs ?? {}) as Record<string, unknown>;
  res.json({
    ...mapOpportunity(row),
    inputs,
    sources: extractSourcesFromInputs(inputs),
    decisions: decisions.map((d) => ({
      id: d.id,
      opportunityId: d.opportunityId,
      eventType: d.eventType,
      actorEmail: d.actor,
      rejectedReasonCode: d.rejectedReasonCode,
      rejectedReasonText: d.rejectedReasonNote,
      realizedSavingsUsd:
        d.realizedSavingsUsd !== null ? Number(d.realizedSavingsUsd) : null,
      notes: null,
      createdAt: d.createdAt,
    })),
  });
});

async function loadOppOrThrow(orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(opportunitiesTable)
    .where(
      and(eq(opportunitiesTable.orgId, orgId), eq(opportunitiesTable.id, id)),
    );
  return row;
}

router.post("/opportunities/:id/approve", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const opp = await loadOppOrThrow(orgId, id);
  if (!opp) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  if (opp.status !== "proposed") {
    res
      .status(409)
      .json({ error: `Cannot approve from status '${opp.status}'` });
    return;
  }
  await db
    .update(opportunitiesTable)
    .set({ status: "approved" })
    .where(eq(opportunitiesTable.id, opp.id));
  await db.insert(decisionsTable).values({
    id: newId("dec"),
    orgId,
    opportunityId: opp.id,
    cycleId: opp.cycleId,
    eventType: "approve",
    actor: req.actorEmail ?? "system@procuro.ai",
  });
  await updateCycleAggregates(orgId, opp.cycleId);
  const [updated] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opp.id));
  res.json(mapOpportunity({ opp: updated! }));
});

router.post("/opportunities/:id/reject", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  // Throw on invalid input and let the global error handler shape the
  // 400 response (`{ error, details }`). See global-error-handler.ts.
  const { reasonCode, reasonText } = rejectOpportunityBodySchema.parse(
    req.body,
  );

  const opp = await loadOppOrThrow(orgId, id);
  if (!opp) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  if (opp.status !== "proposed") {
    res
      .status(409)
      .json({ error: `Cannot reject from status '${opp.status}'` });
    return;
  }
  await db
    .update(opportunitiesTable)
    .set({
      status: "rejected",
      rejectedReasonCode: reasonCode,
      rejectedReasonNote: reasonText,
    })
    .where(eq(opportunitiesTable.id, opp.id));
  await db.insert(decisionsTable).values({
    id: newId("dec"),
    orgId,
    opportunityId: opp.id,
    cycleId: opp.cycleId,
    eventType: "reject",
    actor: req.actorEmail ?? "system@procuro.ai",
    rejectedReasonCode: reasonCode,
    rejectedReasonNote: reasonText,
  });
  await updateCycleAggregates(orgId, opp.cycleId);
  const [updated] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opp.id));
  res.json(mapOpportunity({ opp: updated! }));
});

router.post("/opportunities/:id/execute", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  const opp = await loadOppOrThrow(orgId, id);
  if (!opp) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  if (opp.status !== "approved") {
    res
      .status(409)
      .json({ error: `Cannot mark executing from status '${opp.status}'` });
    return;
  }
  await db
    .update(opportunitiesTable)
    .set({ status: "executing" })
    .where(eq(opportunitiesTable.id, opp.id));
  await db.insert(decisionsTable).values({
    id: newId("dec"),
    orgId,
    opportunityId: opp.id,
    cycleId: opp.cycleId,
    eventType: "execute",
    actor: req.actorEmail ?? "system@procuro.ai",
  });
  await updateCycleAggregates(orgId, opp.cycleId);
  const [updated] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opp.id));
  res.json(mapOpportunity({ opp: updated! }));
});

router.post("/opportunities/:id/realize", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const id = String(req.params.id);
  // Throw on invalid input and let the global error handler shape the
  // 400 response (`{ error, details }`). See global-error-handler.ts.
  const { realizedSavingsUsd } = realizeOpportunityBodySchema.parse(req.body);

  const opp = await loadOppOrThrow(orgId, id);
  if (!opp) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  if (opp.status !== "executing" && opp.status !== "approved") {
    res
      .status(409)
      .json({ error: `Cannot realize from status '${opp.status}'` });
    return;
  }
  await db
    .update(opportunitiesTable)
    .set({
      status: "realized",
      realizedSavingsUsd: realizedSavingsUsd.toFixed(2),
      realizedAt: new Date(),
    })
    .where(eq(opportunitiesTable.id, opp.id));
  await db.insert(decisionsTable).values({
    id: newId("dec"),
    orgId,
    opportunityId: opp.id,
    cycleId: opp.cycleId,
    eventType: "realize",
    actor: req.actorEmail ?? "system@procuro.ai",
    realizedSavingsUsd: realizedSavingsUsd.toFixed(2),
  });
  await updateCycleAggregates(orgId, opp.cycleId);
  const [updated] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opp.id));
  res.json(mapOpportunity({ opp: updated! }));
});

export default router;
