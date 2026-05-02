import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

/** All spend aggregations are DB-side so they scale to F500 line counts. */

export type SpendSegment = "all" | "goods" | "services";

export interface SpendOverview {
  totalSpendUsd: number;
  goodsVsServices: GoodsVsServicesBlock;
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

export interface GoodsVsServicesBlock {
  goodsSpendUsd: number;
  servicesSpendUsd: number;
  goodsShare: number;
  servicesShare: number;
}

export type SpendBand =
  | "indexable"
  | "concentrated"
  | "fragmented"
  | "subscription"
  | "capital"
  | "services";

export interface SpendByBand {
  totalSpendUsd: number;
  unmappedCategoryCount: number;
  unmappedSpendUsd: number;
  byBand: {
    band: SpendBand;
    spendUsd: number;
    share: number;
    categoryCount?: number;
    supplierCount?: number;
    topCategories?: {
      categoryId: string;
      categoryName: string;
      spendUsd: number;
    }[];
  }[];
}

/**
 * Band-first / class-fallback segmentation predicates.
 *
 * Routing rule (per task 217 acceptance criteria): when a category has a
 * `category_bands` row, the band IS the truth — even when it disagrees
 * with the legacy `categories.class` taxonomy. When no band binding
 * exists we fall back to the class taxonomy. This means:
 *
 *   - cat.class='service' AND band='indexable'  -> goods   (band wins)
 *   - cat.class='direct'  AND band='services'   -> services (band wins)
 *   - cat.class='service' AND no band binding   -> services (fallback)
 *   - cat.class='direct'  AND no band binding   -> goods   (fallback)
 *   - cat.class IS NULL   AND no band binding   -> neither (excluded)
 *
 * A correlated EXISTS lookup against `category_bands` reads the band
 * binding for the line's category (NULL when unbound). The CASE makes
 * the band-vs-fallback precedence explicit so reviewers can read it
 * top-to-bottom.
 */
export const SERVICES_PREDICATE_SQL = sql`(
  CASE
    WHEN EXISTS (
      SELECT 1 FROM category_bands cb WHERE cb.category_code = cat.code
    ) THEN EXISTS (
      SELECT 1 FROM category_bands cb
      WHERE cb.category_code = cat.code AND cb.band = 'services'
    )
    ELSE cat.class = 'service'
  END
)`;

/**
 * Goods is the dual of services under the same band-first rule.
 * `goods` covers the five non-services bands (indexable / concentrated
 * / fragmented / subscription / capital) and, when no band exists,
 * the `direct` and `indirect` taxonomy classes. Tail rows with neither
 * a band nor a goods/services class fall through and are excluded
 * from BOTH goods and services so the segments are mutually exclusive
 * but not jointly exhaustive (the unmapped tail surfaces separately
 * via `getSpendByBand().unmappedSpendUsd`).
 */
export const GOODS_PREDICATE_SQL = sql`(
  CASE
    WHEN EXISTS (
      SELECT 1 FROM category_bands cb WHERE cb.category_code = cat.code
    ) THEN EXISTS (
      SELECT 1 FROM category_bands cb
      WHERE cb.category_code = cat.code
        AND cb.band IN ('indexable','concentrated','fragmented','subscription','capital')
    )
    ELSE cat.class IN ('direct','indirect')
  END
)`;

/**
 * Returns a SQL fragment that filters the `po_lines pol` join
 * (alias `pol`, with `categories cat` LEFT JOIN already in scope) to
 * the requested segment. `all` returns TRUE so the WHERE chain is
 * unaffected.
 */
function segmentPredicate(segment: SpendSegment): SQL {
  if (segment === "services") return sql`(${SERVICES_PREDICATE_SQL})`;
  if (segment === "goods") return sql`(${GOODS_PREDICATE_SQL})`;
  return sql`TRUE`;
}

/**
 * Spend overview, optionally narrowed to the goods or services slice.
 * The `goodsVsServices` block is always computed against the full
 * 12-month roll-up so the segmented control on Spend Overview can
 * render its share pills regardless of which segment is active.
 */
export async function getSpendOverview(
  orgId: string,
  segment: SpendSegment = "all",
): Promise<SpendOverview> {
  const segPredicate = segmentPredicate(segment);

  // Total — note we always join categories so the segment predicate
  // can reference `cat.class` / `cat.code`. Lines whose category is
  // missing fall through `LEFT JOIN`; for `goods` they're treated as
  // goods (NOT services-predicate is true when the predicate is
  // false), for `services` they're excluded.
  const totalRow = await db.execute(sql`
    SELECT COALESCE(SUM(pol.extended_usd::numeric),0) AS total_usd
    FROM po_lines pol
    LEFT JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${segPredicate}
  `);
  const totalSpendUsd = Number(
    (totalRow.rows[0] as { total_usd: string } | undefined)?.total_usd ?? 0,
  );

  const byClassRows = await db.execute(sql`
    SELECT pol.spend_class AS spend_class, SUM(pol.extended_usd::numeric) AS spend_usd
    FROM po_lines pol
    LEFT JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${segPredicate}
    GROUP BY pol.spend_class
    ORDER BY spend_usd DESC
  `);
  const byClass = (byClassRows.rows as Array<{ spend_class: string; spend_usd: string }>).map(
    (r) => ({ spendClass: r.spend_class, spendUsd: Number(r.spend_usd) }),
  );

  // Goods vs services split — always against the org-wide total so
  // the segmented control on Spend Overview can show share pills
  // regardless of the active segment. Defined identically to
  // SERVICES_PREDICATE_SQL so the by-Band 'services' bucket and this
  // card always reconcile.
  const gvsRow = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN ${SERVICES_PREDICATE_SQL}
                        THEN pol.extended_usd::numeric
                        ELSE 0 END), 0) AS services_usd,
      COALESCE(SUM(CASE WHEN ${GOODS_PREDICATE_SQL}
                        THEN pol.extended_usd::numeric
                        ELSE 0 END), 0) AS goods_usd
    FROM po_lines pol
    LEFT JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
  `);
  const gvs = gvsRow.rows[0] as
    | { goods_usd: string; services_usd: string }
    | undefined;
  const goodsSpendUsd = Number(gvs?.goods_usd ?? 0);
  const servicesSpendUsd = Number(gvs?.services_usd ?? 0);
  const gvsTotal = goodsSpendUsd + servicesSpendUsd;
  const goodsVsServices: GoodsVsServicesBlock = {
    goodsSpendUsd,
    servicesSpendUsd,
    goodsShare: gvsTotal > 0 ? goodsSpendUsd / gvsTotal : 0,
    servicesShare: gvsTotal > 0 ? servicesSpendUsd / gvsTotal : 0,
  };

  const byCategoryRows = await db.execute(sql`
    SELECT cat.id AS category_id, cat.name AS category_name, cat.class AS category_class,
           SUM(pol.extended_usd::numeric) AS spend_usd
    FROM po_lines pol
    JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${segPredicate}
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

  // Supplier roll-up: sum line spend (not po total) within the
  // segment so the supplier list reconciles with the segmented total.
  const bySupplierRows = await db.execute(sql`
    SELECT s.id AS supplier_id, s.name AS supplier_name,
           SUM(pol.extended_usd::numeric) AS spend_usd,
           COUNT(DISTINCT po.id) AS po_count
    FROM po_lines pol
    JOIN purchase_orders po ON po.id = pol.po_id
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${segPredicate}
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
    SELECT COALESCE(po.business_unit, 'Unassigned') AS business_unit,
           SUM(pol.extended_usd::numeric) AS spend_usd
    FROM po_lines pol
    JOIN purchase_orders po ON po.id = pol.po_id
    LEFT JOIN categories cat ON cat.id = pol.category_id
    WHERE pol.org_id = ${orgId}
      AND pol.order_date >= NOW() - INTERVAL '365 days'
      AND ${segPredicate}
    GROUP BY po.business_unit
    ORDER BY spend_usd DESC
  `);
  const byBusinessUnit = (
    byBuRows.rows as Array<{ business_unit: string; spend_usd: string }>
  ).map((r) => ({
    businessUnit: r.business_unit,
    spendUsd: Number(r.spend_usd),
  }));

  // Concentration is keyed off supplier line spend within the
  // segment so the tail / top-10 numbers reconcile.
  const concRow = await db.execute(sql`
    WITH supplier_spend AS (
      SELECT po.supplier_id, SUM(pol.extended_usd::numeric) AS total
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      LEFT JOIN categories cat ON cat.id = pol.category_id
      WHERE pol.org_id = ${orgId}
        AND pol.order_date >= NOW() - INTERVAL '365 days'
        AND ${segPredicate}
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
    goodsVsServices,
    byClass,
    byCategory,
    bySupplier,
    byBusinessUnit,
    concentration,
  };
}

/**
 * Returns trailing-90-day spend bucketed by routing band. The window
 * is shorter than the overview's 365d so the band signal stays
 * recent enough to drive routing decisions. The six bands come from
 * the routing model (`category_bands` truth table); categories
 * without an explicit `category_bands` row ALWAYS fall back to
 * `fragmented` (regardless of class) so the bucket totals reconcile
 * to the overall 90d total and operators see a single, consistent
 * "unrouted" tail. Those fall-through rows are tallied separately as
 * `unmappedCategoryCount` / `unmappedSpendUsd` so the operator can
 * prioritise routing work against the addressable but un-routed
 * tail. The `services` band is therefore reserved for categories
 * that are EXPLICITLY bound to `band='services'` in the routing
 * truth table — class='service' alone is not enough.
 */
export async function getSpendByBand(orgId: string): Promise<SpendByBand> {
  const rows = await db.execute(sql`
    WITH lines AS (
      SELECT pol.extended_usd::numeric AS amt,
             cat.id AS category_id,
             cat.code AS category_code,
             cat.name AS category_name,
             cat.class AS category_class,
             po.supplier_id
      FROM po_lines pol
      JOIN purchase_orders po ON po.id = pol.po_id
      LEFT JOIN categories cat ON cat.id = pol.category_id
      WHERE pol.org_id = ${orgId}
        AND pol.order_date >= NOW() - INTERVAL '90 days'
    ),
    banded AS (
      SELECT l.amt,
             l.category_id,
             l.category_name,
             l.category_class,
             l.category_code,
             l.supplier_id,
             COALESCE(
               (SELECT cb.band FROM category_bands cb
                WHERE cb.category_code = l.category_code
                ORDER BY cb.band LIMIT 1),
               'fragmented'
             ) AS band,
             -- Unmapped = no explicit band binding. Includes class='service'
             -- categories that aren't bound to band='services' — they flow
             -- into 'fragmented' above so totals reconcile. The unmapped
             -- tally surfaces the routing gap to the operator.
             (
               (SELECT cb.band FROM category_bands cb
                WHERE cb.category_code = l.category_code LIMIT 1) IS NULL
             ) AS is_unmapped
      FROM lines l
    ),
    band_totals AS (
      SELECT band,
             COALESCE(SUM(amt), 0) AS spend_usd,
             COUNT(DISTINCT category_id) AS category_count,
             COUNT(DISTINCT supplier_id) AS supplier_count
      FROM banded
      GROUP BY band
    ),
    cat_in_band AS (
      SELECT band, category_id, category_name,
             SUM(amt) AS cat_spend
      FROM banded
      WHERE category_id IS NOT NULL
      GROUP BY band, category_id, category_name
    ),
    cat_ranked AS (
      SELECT band, category_id, category_name, cat_spend,
             ROW_NUMBER() OVER (PARTITION BY band ORDER BY cat_spend DESC) AS rn
      FROM cat_in_band
    ),
    unmapped AS (
      SELECT
        COALESCE(SUM(amt), 0) AS spend_usd,
        COUNT(DISTINCT category_id) AS category_count
      FROM banded
      WHERE is_unmapped
    )
    SELECT
      'totals' AS kind,
      bt.band AS band,
      bt.spend_usd::text AS spend_usd,
      bt.category_count::text AS category_count,
      bt.supplier_count::text AS supplier_count,
      NULL AS category_id,
      NULL AS category_name,
      NULL::text AS cat_spend
    FROM band_totals bt
    UNION ALL
    SELECT
      'top_cat' AS kind,
      cr.band AS band,
      NULL AS spend_usd,
      NULL AS category_count,
      NULL AS supplier_count,
      cr.category_id,
      cr.category_name,
      cr.cat_spend::text AS cat_spend
    FROM cat_ranked cr
    UNION ALL
    SELECT
      'unmapped' AS kind,
      NULL AS band,
      u.spend_usd::text AS spend_usd,
      u.category_count::text AS category_count,
      NULL AS supplier_count,
      NULL AS category_id,
      NULL AS category_name,
      NULL AS cat_spend
    FROM unmapped u
  `);

  type RowAny = {
    kind: "totals" | "top_cat" | "unmapped";
    band: SpendBand | null;
    spend_usd: string | null;
    category_count: string | null;
    supplier_count: string | null;
    category_id: string | null;
    category_name: string | null;
    cat_spend: string | null;
  };

  const tally = new Map<
    SpendBand,
    {
      spendUsd: number;
      categoryCount: number;
      supplierCount: number;
      topCategories: { categoryId: string; categoryName: string; spendUsd: number }[];
    }
  >();
  let unmappedSpendUsd = 0;
  let unmappedCategoryCount = 0;

  for (const r of rows.rows as RowAny[]) {
    if (r.kind === "totals" && r.band) {
      tally.set(r.band, {
        spendUsd: Number(r.spend_usd ?? 0),
        categoryCount: Number(r.category_count ?? 0),
        supplierCount: Number(r.supplier_count ?? 0),
        topCategories: [],
      });
    } else if (r.kind === "top_cat" && r.band && r.category_id) {
      const t = tally.get(r.band);
      if (t) {
        t.topCategories.push({
          categoryId: r.category_id,
          categoryName: r.category_name ?? "(unnamed)",
          spendUsd: Number(r.cat_spend ?? 0),
        });
      }
    } else if (r.kind === "unmapped") {
      unmappedSpendUsd = Number(r.spend_usd ?? 0);
      unmappedCategoryCount = Number(r.category_count ?? 0);
    }
  }

  const allBands: SpendBand[] = [
    "indexable",
    "concentrated",
    "fragmented",
    "subscription",
    "capital",
    "services",
  ];
  const totalSpendUsd = Array.from(tally.values()).reduce(
    (a, b) => a + b.spendUsd,
    0,
  );

  const byBand = allBands.map((band) => {
    const t = tally.get(band) ?? {
      spendUsd: 0,
      categoryCount: 0,
      supplierCount: 0,
      topCategories: [],
    };
    return {
      band,
      spendUsd: t.spendUsd,
      share: totalSpendUsd > 0 ? t.spendUsd / totalSpendUsd : 0,
      categoryCount: t.categoryCount,
      supplierCount: t.supplierCount,
      topCategories: t.topCategories,
    };
  });

  return {
    totalSpendUsd,
    unmappedCategoryCount,
    unmappedSpendUsd,
    byBand,
  };
}
