import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { tenantMiddleware, requireOrgId } from "../lib/tenant";
import { SERVICES_PREDICATE_SQL } from "../lib/spend";

const router: IRouter = Router();

// ─── GET /services/spend ─────────────────────────────────────────────────
//
// Trailing-12-month services-only rollup. "Services" is determined by
// the canonical `SERVICES_PREDICATE_SQL` fragment (categories.class
// = 'service' OR category bound to the `services` band). This makes
// every services rollup in the API — by-Band, Spend Overview's
// `goodsVsServices` block, and this slice — reconcile to the same
// total. The `byContractType` breakdown still reads from the
// owning contract because that's the *commercial* dimension the
// services workspace cares about (T&M vs fixed-price vs …) — lines
// without a contract land in `goods` here so the contract-type
// breakdown stays meaningful.

router.get("/services/spend", tenantMiddleware, async (req, res) => {
  const orgId = requireOrgId(req);
  // Optional supplier deep-link filter. When set, every aggregate
  // (total, byContractType, topCategories) reduces to that one
  // supplier's services spend so the operator pivoting from a
  // supplier 360 sees a coherent slice. `topSuppliers` is then
  // trivially a one-row list — kept in the payload so the FE
  // shape stays stable across filtered/unfiltered modes.
  const supplierId =
    typeof req.query.supplierId === "string" && req.query.supplierId.trim()
      ? req.query.supplierId.trim()
      : null;
  const supplierFilter = supplierId
    ? sql`AND po.supplier_id = ${supplierId}`
    : sql``;

  const totalRow = await db.execute(sql`
    SELECT COALESCE(SUM(pol.extended_usd::numeric), 0) AS total_usd
    FROM po_lines pol
    JOIN purchase_orders po ON po.id = pol.po_id
    LEFT JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${SERVICES_PREDICATE_SQL}
      ${supplierFilter}
  `);
  const totalServicesSpendUsd = Number(
    (totalRow.rows[0] as { total_usd: string } | undefined)?.total_usd ?? 0,
  );

  const byTypeRows = await db.execute(sql`
    SELECT COALESCE(c.contract_type, 'goods') AS contract_type,
           COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend_usd
    FROM po_lines pol
    JOIN purchase_orders po ON po.id = pol.po_id
    LEFT JOIN contracts c ON c.id = po.contract_id
    LEFT JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${SERVICES_PREDICATE_SQL}
      ${supplierFilter}
    GROUP BY COALESCE(c.contract_type, 'goods')
    ORDER BY spend_usd DESC
  `);
  const byContractType = (
    byTypeRows.rows as Array<{ contract_type: string; spend_usd: string }>
  ).map((r) => {
    const spendUsd = Number(r.spend_usd);
    return {
      contractType: r.contract_type,
      spendUsd,
      share: totalServicesSpendUsd > 0 ? spendUsd / totalServicesSpendUsd : 0,
    };
  });

  const topSuppliersRows = await db.execute(sql`
    SELECT s.id AS supplier_id, s.name AS supplier_name,
           COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend_usd
    FROM po_lines pol
    JOIN purchase_orders po ON po.id = pol.po_id
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${SERVICES_PREDICATE_SQL}
      ${supplierFilter}
    GROUP BY s.id, s.name
    ORDER BY spend_usd DESC
    LIMIT 10
  `);
  const topSuppliers = (
    topSuppliersRows.rows as Array<{
      supplier_id: string;
      supplier_name: string;
      spend_usd: string;
    }>
  ).map((r) => ({
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    spendUsd: Number(r.spend_usd),
  }));

  const topCategoriesRows = await db.execute(sql`
    SELECT cat.code AS category_code, cat.name AS category_name,
           COALESCE(SUM(pol.extended_usd::numeric), 0) AS spend_usd
    FROM po_lines pol
    JOIN purchase_orders po ON po.id = pol.po_id
    JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${SERVICES_PREDICATE_SQL}
      ${supplierFilter}
    GROUP BY cat.code, cat.name
    ORDER BY spend_usd DESC
    LIMIT 10
  `);
  const topCategories = (
    topCategoriesRows.rows as Array<{
      category_code: string;
      category_name: string;
      spend_usd: string;
    }>
  ).map((r) => ({
    categoryCode: r.category_code,
    categoryName: r.category_name,
    spendUsd: Number(r.spend_usd),
  }));

  res.json({
    totalServicesSpendUsd,
    byContractType,
    topSuppliers,
    topCategories,
  });
});

export default router;
