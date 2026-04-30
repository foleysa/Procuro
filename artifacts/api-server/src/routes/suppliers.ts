import { Router, type IRouter } from "express";
import { db, suppliersTable } from "@workspace/db";
import { and, eq, ilike, gt, asc } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";

const router: IRouter = Router();

router.get("/suppliers", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  const search = (req.query.search as string | undefined)?.trim();
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    200,
  );
  const cursor = req.query.cursor as string | undefined;

  const where = [eq(suppliersTable.orgId, orgId)];
  if (search) where.push(ilike(suppliersTable.name, `%${search}%`));
  if (cursor) where.push(gt(suppliersTable.id, cursor));

  const rows = await db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
      countryCode: suppliersTable.countryCode,
      paymentTermsDays: suppliersTable.paymentTermsDays,
      isStrategic: suppliersTable.isStrategic,
      isPreferred: suppliersTable.isPreferred,
      tags: suppliersTable.tags,
    })
    .from(suppliersTable)
    .where(and(...where))
    .orderBy(asc(suppliersTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    items,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
  });
});

export default router;
