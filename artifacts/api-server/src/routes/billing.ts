import { Router, type IRouter } from "express";
import { db, opportunitiesTable, orgsTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";

const router: IRouter = Router();

router.get("/billing/summary", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const [org] = await db
    .select({ successFeePct: orgsTable.successFeePct })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId));
  const successFeePct = Number(org?.successFeePct ?? 25);

  const totals = await db.execute(sql`
    SELECT
      COALESCE(SUM(realized_savings_usd::numeric), 0) AS realized,
      COALESCE(SUM(projected_savings_usd::numeric), 0) AS projected
    FROM opportunities
    WHERE org_id = ${orgId}
  `);
  const t = totals.rows[0] as { realized: string; projected: string };
  const totalRealizedUsd = Number(t.realized);
  const totalProjectedUsd = Number(t.projected);
  const successFeeUsd = (totalRealizedUsd * successFeePct) / 100;

  const byLeverRows = await db.execute(sql`
    SELECT lever_id,
           COALESCE(SUM(realized_savings_usd::numeric), 0) AS realized,
           COALESCE(SUM(projected_savings_usd::numeric), 0) AS projected,
           COUNT(*) AS count
    FROM opportunities
    WHERE org_id = ${orgId}
    GROUP BY lever_id
    ORDER BY realized DESC
  `);
  const byLever = (
    byLeverRows.rows as Array<{
      lever_id: string;
      realized: string;
      projected: string;
      count: string;
    }>
  ).map((r) => ({
    leverId: r.lever_id,
    realizedUsd: Number(r.realized),
    projectedUsd: Number(r.projected),
    opportunityCount: Number(r.count),
  }));

  res.json({
    successFeePct,
    totalRealizedUsd,
    totalProjectedUsd,
    successFeeUsd,
    byLever,
  });
});

export default router;
