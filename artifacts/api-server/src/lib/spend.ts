import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** All spend aggregations are DB-side so they scale to F500 line counts. */

export interface SpendOverview {
  totalSpendUsd: number;
  byClass: { spendClass: string; spendUsd: number }[];
  byCategory: {
    categoryId: string;
    categoryName: string;
    categoryClass: string;
    spendUsd: number;
  }[];
  bySupplier: {
    supplierId: string;
    supplierName: string;
    spendUsd: number;
    poCount: number;
  }[];
  byBusinessUnit: { businessUnit: string; spendUsd: number }[];
  concentration: {
    top10SupplierShare: number;
    activeSupplierCount: number;
    tailSupplierCount: number;
    tailSpendUsd: number;
  };
}

export async function getSpendOverview(orgId: string): Promise<SpendOverview> {
  const totalRow = await db.execute(sql`
    SELECT COALESCE(SUM(extended_usd::numeric),0) AS total_usd
    FROM po_lines
    WHERE org_id = ${orgId}
      AND order_date >= NOW() - INTERVAL '365 days'
  `);
  const totalSpendUsd = Number(
    (totalRow.rows[0] as { total_usd: string } | undefined)?.total_usd ?? 0,
  );

  const byClassRows = await db.execute(sql`
    SELECT spend_class, SUM(extended_usd::numeric) AS spend_usd
    FROM po_lines
    WHERE org_id = ${orgId}
      AND order_date >= NOW() - INTERVAL '365 days'
    GROUP BY spend_class
    ORDER BY spend_usd DESC
  `);
  const byClass = (byClassRows.rows as Array<{ spend_class: string; spend_usd: string }>).map(
    (r) => ({ spendClass: r.spend_class, spendUsd: Number(r.spend_usd) }),
  );

  const byCategoryRows = await db.execute(sql`
    SELECT cat.id AS category_id, cat.name AS category_name, cat.class AS category_class,
           SUM(pol.extended_usd::numeric) AS spend_usd
    FROM po_lines pol
    JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
    GROUP BY cat.id, cat.name, cat.class
    ORDER BY spend_usd DESC
    LIMIT 25
  `);
  const byCategory = (
    byCategoryRows.rows as Array<{
      category_id: string;
      category_name: string;
      category_class: string;
      spend_usd: string;
    }>
  ).map((r) => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryClass: r.category_class,
    spendUsd: Number(r.spend_usd),
  }));

  const bySupplierRows = await db.execute(sql`
    SELECT s.id AS supplier_id, s.name AS supplier_name,
           SUM(po.total_usd::numeric) AS spend_usd,
           COUNT(po.id) AS po_count
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.org_id = ${orgId}
      AND po.order_date >= NOW() - INTERVAL '365 days'
    GROUP BY s.id, s.name
    ORDER BY spend_usd DESC
    LIMIT 25
  `);
  const bySupplier = (
    bySupplierRows.rows as Array<{
      supplier_id: string;
      supplier_name: string;
      spend_usd: string;
      po_count: string;
    }>
  ).map((r) => ({
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    spendUsd: Number(r.spend_usd),
    poCount: Number(r.po_count),
  }));

  const byBuRows = await db.execute(sql`
    SELECT COALESCE(business_unit, 'Unassigned') AS business_unit,
           SUM(total_usd::numeric) AS spend_usd
    FROM purchase_orders
    WHERE org_id = ${orgId}
      AND order_date >= NOW() - INTERVAL '365 days'
    GROUP BY business_unit
    ORDER BY spend_usd DESC
  `);
  const byBusinessUnit = (
    byBuRows.rows as Array<{ business_unit: string; spend_usd: string }>
  ).map((r) => ({
    businessUnit: r.business_unit,
    spendUsd: Number(r.spend_usd),
  }));

  const concRow = await db.execute(sql`
    WITH supplier_spend AS (
      SELECT po.supplier_id, SUM(po.total_usd::numeric) AS total
      FROM purchase_orders po
      WHERE po.org_id = ${orgId}
        AND po.order_date >= NOW() - INTERVAL '365 days'
      GROUP BY po.supplier_id
    ),
    ranked AS (
      SELECT supplier_id, total, RANK() OVER (ORDER BY total DESC) AS rk
      FROM supplier_spend
    )
    SELECT
      (SELECT COALESCE(SUM(total),0) FROM ranked WHERE rk <= 10)::numeric AS top10,
      (SELECT COALESCE(SUM(total),0) FROM supplier_spend)::numeric AS total,
      (SELECT COUNT(*) FROM supplier_spend) AS active_count,
      (SELECT COUNT(*) FROM supplier_spend WHERE total < 25000) AS tail_count,
      (SELECT COALESCE(SUM(total),0) FROM supplier_spend WHERE total < 25000)::numeric AS tail_spend
  `);
  const cr = concRow.rows[0] as
    | {
        top10: string;
        total: string;
        active_count: string;
        tail_count: string;
        tail_spend: string;
      }
    | undefined;
  const total = Number(cr?.total ?? 0);
  const top10 = Number(cr?.top10 ?? 0);
  const concentration = {
    top10SupplierShare: total > 0 ? top10 / total : 0,
    activeSupplierCount: Number(cr?.active_count ?? 0),
    tailSupplierCount: Number(cr?.tail_count ?? 0),
    tailSpendUsd: Number(cr?.tail_spend ?? 0),
  };

  return {
    totalSpendUsd,
    byClass,
    byCategory,
    bySupplier,
    byBusinessUnit,
    concentration,
  };
}
