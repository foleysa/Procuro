import { db } from "@workspace/db";
import {
  poLinesTable,
  purchaseOrdersTable,
  contractsTable,
  contractItemsTable,
  suppliersTable,
  invoicesTable,
  paymentsTable,
  itemsTable,
  categoriesTable,
} from "@workspace/db";
import { and, eq, sql, gte } from "drizzle-orm";
import type { LeverAnalyzer, OpportunityDraft } from "./types";

const dollars = (n: number) => Math.round(n * 100) / 100;

/**
 * Lever 1 — SKU price benchmarking.
 * Same item bought at different prices across POs / sites / business units.
 * Opportunity = move all buys to the lowest verified price.
 */
export const skuPriceBenchmarkLever: LeverAnalyzer = {
  leverId: "sku_price_benchmark",
  tier: 1,
  label: "SKU Price Benchmarking",
  description:
    "Same item bought at materially different unit prices across POs / sites / business units. Move all buys to the lowest verified price.",
  async analyze({ orgId }) {
    // Aggregate per (item normalized key): min/max/avg unit price + total volume.
    // Only flag items where (max - min)/min > threshold and total spend material.
    const rows = await db.execute(sql`
      WITH agg AS (
        SELECT pol.org_id,
               pol.sku,
               COALESCE(MAX(i.normalized_key), pol.sku) AS norm_key,
               MIN(pol.unit_price_usd::numeric) AS min_price,
               MAX(pol.unit_price_usd::numeric) AS max_price,
               AVG(pol.unit_price_usd::numeric) AS avg_price,
               SUM(pol.qty::numeric) AS total_qty,
               SUM(pol.extended_usd::numeric) AS total_spend,
               COUNT(*) AS line_count,
               COUNT(DISTINCT pol.po_id) AS po_count
        FROM po_lines pol
        LEFT JOIN items i ON i.id = pol.item_id
        WHERE pol.org_id = ${orgId}
          AND pol.order_date >= NOW() - INTERVAL '365 days'
        GROUP BY pol.org_id, pol.sku, i.normalized_key
      )
      SELECT * FROM agg
      WHERE max_price > min_price * 1.10
        AND total_spend > 5000
        AND po_count >= 3
      ORDER BY (max_price - min_price) * total_qty DESC
      LIMIT 25
    `);
    const drafts: OpportunityDraft[] = [];
    for (const r of rows.rows as Array<{
      sku: string;
      norm_key: string;
      min_price: string;
      max_price: string;
      avg_price: string;
      total_qty: string;
      total_spend: string;
      line_count: string;
      po_count: string;
    }>) {
      const minPrice = Number(r.min_price);
      const avgPrice = Number(r.avg_price);
      const totalQty = Number(r.total_qty);
      const savings = (avgPrice - minPrice) * totalQty;
      if (savings < 500) continue;
      drafts.push({
        leverId: "sku_price_benchmark",
        title: `Standardize ${r.sku} to lowest verified price`,
        rationale: `${r.po_count} POs across the last 12 months bought ${r.sku} at unit prices ranging from $${minPrice.toFixed(2)} to $${Number(r.max_price).toFixed(2)} (avg $${avgPrice.toFixed(2)}). Total annual volume: ${totalQty.toFixed(0)} units, total spend $${Number(r.total_spend).toFixed(0)}.`,
        recommendedAction: `Negotiate all sites onto the verified low price ($${minPrice.toFixed(2)}/unit) and add a price ceiling clause to the supplier MSA.`,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          sku: r.sku,
          minPriceUsd: minPrice,
          avgPriceUsd: avgPrice,
          maxPriceUsd: Number(r.max_price),
          totalQty,
          totalSpendUsd: Number(r.total_spend),
          poCount: Number(r.po_count),
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 2 — Maverick spend.
 * POs placed outside an existing contract for items/categories that ARE under
 * contract. Redirect spend to the contracted supplier at contracted price.
 */
export const maverickSpendLever: LeverAnalyzer = {
  leverId: "maverick_spend",
  tier: 1,
  label: "Maverick Spend Detection",
  description:
    "Spend placed outside of an existing contract for items/categories that are under contract. Redirect to the contracted supplier at the contracted price.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      WITH contract_skus AS (
        SELECT ci.sku,
               MIN(ci.contracted_unit_price_usd::numeric) AS contract_price,
               MIN(c.supplier_id) AS contracted_supplier_id,
               MIN(s.name) AS contracted_supplier_name
        FROM contract_items ci
        JOIN contracts c ON c.id = ci.contract_id
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE ci.org_id = ${orgId} AND c.status = 'active'
        GROUP BY ci.sku
      ),
      maverick AS (
        SELECT pol.sku,
               cs.contracted_supplier_id,
               cs.contracted_supplier_name,
               cs.contract_price,
               SUM(pol.qty::numeric) AS total_qty,
               SUM(pol.extended_usd::numeric) AS total_spend,
               AVG(pol.unit_price_usd::numeric) AS avg_paid,
               COUNT(*) AS line_count
        FROM po_lines pol
        JOIN purchase_orders po ON po.id = pol.po_id
        JOIN contract_skus cs ON cs.sku = pol.sku
        WHERE pol.org_id = ${orgId}
          AND po.supplier_id <> cs.contracted_supplier_id
          AND pol.order_date >= NOW() - INTERVAL '365 days'
        GROUP BY pol.sku, cs.contracted_supplier_id, cs.contracted_supplier_name, cs.contract_price
      )
      SELECT * FROM maverick
      WHERE total_spend > 2500
      ORDER BY (avg_paid - contract_price) * total_qty DESC
      LIMIT 25
    `);
    const drafts: OpportunityDraft[] = [];
    for (const r of rows.rows as Array<{
      sku: string;
      contracted_supplier_id: string;
      contracted_supplier_name: string;
      contract_price: string;
      total_qty: string;
      total_spend: string;
      avg_paid: string;
      line_count: string;
    }>) {
      const avgPaid = Number(r.avg_paid);
      const contractPrice = Number(r.contract_price);
      const totalQty = Number(r.total_qty);
      const delta = avgPaid - contractPrice;
      const savings = delta > 0 ? delta * totalQty : 0;
      if (savings < 250) continue;
      drafts.push({
        leverId: "maverick_spend",
        title: `Redirect ${r.sku} maverick spend to ${r.contracted_supplier_name}`,
        rationale: `${r.line_count} POs in the last 12 months bought ${r.sku} from non-contracted suppliers at avg $${avgPaid.toFixed(2)}/unit while a live contract with ${r.contracted_supplier_name} prices the same SKU at $${contractPrice.toFixed(2)}/unit.`,
        recommendedAction: `Route all ${r.sku} demand to ${r.contracted_supplier_name} per contracted pricing; block off-contract POs at the requisition workflow.`,
        supplierId: r.contracted_supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          sku: r.sku,
          contractedSupplierId: r.contracted_supplier_id,
          contractPriceUsd: contractPrice,
          avgPaidUsd: avgPaid,
          maverickQty: totalQty,
          maverickSpendUsd: Number(r.total_spend),
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 3 — Contract leakage.
 * Buying from a non-preferred supplier when a preferred supplier exists for
 * the same category at better terms.
 */
export const contractLeakageLever: LeverAnalyzer = {
  leverId: "contract_leakage",
  tier: 1,
  label: "Contract Leakage",
  description:
    "Buying from a non-preferred supplier when a contracted preferred supplier exists for the same category at better terms.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      WITH preferred AS (
        SELECT DISTINCT c.category_id, c.supplier_id, s.name AS supplier_name
        FROM contracts c
        JOIN suppliers s ON s.id = c.supplier_id
        WHERE c.org_id = ${orgId}
          AND c.status = 'active'
          AND s.is_preferred = TRUE
          AND c.category_id IS NOT NULL
      ),
      leakage AS (
        SELECT pol.category_id,
               cat.name AS category_name,
               p.supplier_id AS preferred_supplier_id,
               p.supplier_name AS preferred_supplier_name,
               po.supplier_id AS leak_supplier_id,
               s2.name AS leak_supplier_name,
               SUM(pol.extended_usd::numeric) AS leak_spend,
               COUNT(*) AS line_count
        FROM po_lines pol
        JOIN purchase_orders po ON po.id = pol.po_id
        JOIN suppliers s2 ON s2.id = po.supplier_id
        JOIN preferred p ON p.category_id = pol.category_id
        JOIN categories cat ON cat.id = pol.category_id
        WHERE pol.org_id = ${orgId}
          AND po.supplier_id <> p.supplier_id
          AND pol.order_date >= NOW() - INTERVAL '365 days'
        GROUP BY pol.category_id, cat.name, p.supplier_id, p.supplier_name,
                 po.supplier_id, s2.name
      )
      SELECT * FROM leakage
      WHERE leak_spend > 5000
      ORDER BY leak_spend DESC
      LIMIT 20
    `);
    const drafts: OpportunityDraft[] = [];
    for (const r of rows.rows as Array<{
      category_id: string;
      category_name: string;
      preferred_supplier_id: string;
      preferred_supplier_name: string;
      leak_supplier_id: string;
      leak_supplier_name: string;
      leak_spend: string;
      line_count: string;
    }>) {
      const leakSpend = Number(r.leak_spend);
      // Conservative: assume 8% savings by routing to preferred supplier.
      const savings = leakSpend * 0.08;
      drafts.push({
        leverId: "contract_leakage",
        title: `Route ${r.category_name} from ${r.leak_supplier_name} to preferred ${r.preferred_supplier_name}`,
        rationale: `$${leakSpend.toFixed(0)} of ${r.category_name} spend last 12 months landed with non-preferred ${r.leak_supplier_name} despite an active preferred contract with ${r.preferred_supplier_name}.`,
        recommendedAction: `Migrate this category's PO routing to the preferred contract and notify the requisitioner.`,
        categoryId: r.category_id,
        supplierId: r.preferred_supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          categoryId: r.category_id,
          preferredSupplierId: r.preferred_supplier_id,
          leakSupplierId: r.leak_supplier_id,
          leakSpendUsd: leakSpend,
          assumedSavingsPct: 8,
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 4 — Duplicate PO / duplicate payment detection.
 * Same invoice paid twice, same PO issued twice.
 */
export const duplicatePaymentLever: LeverAnalyzer = {
  leverId: "duplicate_payment",
  tier: 1,
  label: "Duplicate PO / Payment Detection",
  description:
    "Invoices paid twice, near-duplicate POs, and identical line items billed across invoices. Recovery + prevention.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      SELECT i.dedup_key,
             i.supplier_id,
             s.name AS supplier_name,
             SUM(i.amount_usd::numeric) AS total_paid,
             MIN(i.amount_usd::numeric) AS unit_amount,
             COUNT(*) AS dup_count,
             ARRAY_AGG(i.invoice_number) AS invoice_numbers
      FROM invoices i
      JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.org_id = ${orgId}
        AND i.invoice_date >= NOW() - INTERVAL '365 days'
      GROUP BY i.dedup_key, i.supplier_id, s.name
      HAVING COUNT(*) > 1
      ORDER BY (COUNT(*) - 1) * MIN(i.amount_usd::numeric) DESC
      LIMIT 25
    `);
    const drafts: OpportunityDraft[] = [];
    for (const r of rows.rows as Array<{
      dedup_key: string;
      supplier_id: string;
      supplier_name: string;
      total_paid: string;
      unit_amount: string;
      dup_count: string;
      invoice_numbers: string[];
    }>) {
      const dupCount = Number(r.dup_count);
      const unit = Number(r.unit_amount);
      // Extra payments beyond first.
      const recovery = unit * (dupCount - 1);
      if (recovery < 100) continue;
      drafts.push({
        leverId: "duplicate_payment",
        title: `Recover duplicate payment to ${r.supplier_name}`,
        rationale: `${dupCount} invoices share dedup key ${r.dedup_key} for $${unit.toFixed(2)} each. Invoice numbers: ${r.invoice_numbers.join(", ")}.`,
        recommendedAction: `Contact AP to recover the $${recovery.toFixed(2)} duplicate payment(s) and add a dedup-key check at invoice ingestion.`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(recovery),
        inputs: {
          dedupKey: r.dedup_key,
          supplierId: r.supplier_id,
          duplicateInvoices: r.invoice_numbers,
          unitAmountUsd: unit,
          duplicateCount: dupCount,
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 5 — Missed volume-discount thresholds.
 * Contract has tier-pricing breakpoints; actual volume landed just under one.
 */
export const missedVolumeThresholdLever: LeverAnalyzer = {
  leverId: "missed_volume_threshold",
  tier: 1,
  label: "Missed Volume-Discount Thresholds",
  description:
    "Tier-priced contracts where actual volume landed just below a breakpoint. Aggregate or time-shift demand to clear the next tier.",
  async analyze({ orgId }) {
    const ciRows = await db
      .select({
        id: contractItemsTable.id,
        contractId: contractItemsTable.contractId,
        sku: contractItemsTable.sku,
        tiers: contractItemsTable.tiers,
        contractedUnitPriceUsd: contractItemsTable.contractedUnitPriceUsd,
      })
      .from(contractItemsTable)
      .where(eq(contractItemsTable.orgId, orgId));

    const drafts: OpportunityDraft[] = [];
    for (const ci of ciRows) {
      if (!ci.tiers || ci.tiers.length === 0) continue;
      // Sum 12-month volume for this sku across the tenant.
      const volRow = await db.execute(sql`
        SELECT COALESCE(SUM(qty::numeric),0) AS qty
        FROM po_lines
        WHERE org_id = ${orgId}
          AND sku = ${ci.sku}
          AND order_date >= NOW() - INTERVAL '365 days'
      `);
      const totalQty = Number(
        (volRow.rows[0] as { qty: string } | undefined)?.qty ?? 0,
      );
      if (totalQty <= 0) continue;
      const sortedTiers = [...ci.tiers].sort((a, b) => a.minQty - b.minQty);
      const currentTier =
        sortedTiers.filter((t) => totalQty >= t.minQty).at(-1) ?? null;
      const nextTier = sortedTiers.find((t) => totalQty < t.minQty);
      if (!nextTier || !currentTier) continue;
      const gap = nextTier.minQty - totalQty;
      // Heuristic: only flag if within 20% of the threshold.
      if (gap > totalQty * 0.2) continue;
      const futureQty = nextTier.minQty;
      const savings =
        (currentTier.unitPriceUsd - nextTier.unitPriceUsd) * futureQty;
      if (savings < 500) continue;
      drafts.push({
        leverId: "missed_volume_threshold",
        title: `Aggregate ${ci.sku} demand to clear next tier (${nextTier.minQty.toLocaleString()} units)`,
        rationale: `Annual volume of ${totalQty.toFixed(0)} units fell ${gap.toFixed(0)} short of the next pricing tier (${nextTier.minQty.toLocaleString()} units @ $${nextTier.unitPriceUsd}). Closing the gap drops unit price from $${currentTier.unitPriceUsd} to $${nextTier.unitPriceUsd}.`,
        recommendedAction: `Aggregate demand across sites or pull-forward Q1 to clear the threshold; document with the supplier.`,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          sku: ci.sku,
          contractItemId: ci.id,
          totalQty,
          currentTier,
          nextTier,
          gap,
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 6 — Payment-term extension.
 * Suppliers paid on shorter terms than portfolio norm with no discount.
 */
export const paymentTermExtensionLever: LeverAnalyzer = {
  leverId: "payment_term_extension",
  tier: 1,
  label: "Payment-Term Extension",
  description:
    "Suppliers paid on shorter terms than portfolio norm without a discount justifying it. Extend terms; capture working-capital benefit.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      SELECT s.id AS supplier_id,
             s.name AS supplier_name,
             AVG(p.payment_terms_days) AS avg_terms,
             SUM(p.amount_usd::numeric) AS total_paid
      FROM payments p
      JOIN suppliers s ON s.id = (SELECT supplier_id FROM invoices WHERE id = p.invoice_id)
      WHERE p.org_id = ${orgId}
        AND p.paid_date >= NOW() - INTERVAL '365 days'
      GROUP BY s.id, s.name
      HAVING AVG(p.payment_terms_days) < 30 AND SUM(p.amount_usd::numeric) > 25000
      ORDER BY SUM(p.amount_usd::numeric) DESC
      LIMIT 25
    `);
    const drafts: OpportunityDraft[] = [];
    const PORTFOLIO_NORM_DAYS = 45;
    const COST_OF_CAPITAL_PCT = 6.5;
    for (const r of rows.rows as Array<{
      supplier_id: string;
      supplier_name: string;
      avg_terms: string;
      total_paid: string;
    }>) {
      const avgTerms = Number(r.avg_terms);
      const totalPaid = Number(r.total_paid);
      if (avgTerms >= PORTFOLIO_NORM_DAYS) continue;
      const dayDelta = PORTFOLIO_NORM_DAYS - avgTerms;
      const savings = (totalPaid * (COST_OF_CAPITAL_PCT / 100) * dayDelta) / 365;
      if (savings < 250) continue;
      drafts.push({
        leverId: "payment_term_extension",
        title: `Extend payment terms for ${r.supplier_name} from ~${avgTerms.toFixed(0)}d to ${PORTFOLIO_NORM_DAYS}d`,
        rationale: `${r.supplier_name} is paid on ~${avgTerms.toFixed(0)} day terms vs. portfolio norm of ${PORTFOLIO_NORM_DAYS}d, with $${totalPaid.toFixed(0)} paid in the last 12 months. No discount justifies the early payment.`,
        recommendedAction: `Negotiate terms to ${PORTFOLIO_NORM_DAYS}d net; if supplier demands a discount, model the trade-off vs cost of capital (assumed ${COST_OF_CAPITAL_PCT}%).`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          supplierId: r.supplier_id,
          currentAvgTermsDays: avgTerms,
          targetTermsDays: PORTFOLIO_NORM_DAYS,
          totalPaidUsd: totalPaid,
          costOfCapitalPct: COST_OF_CAPITAL_PCT,
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 7 — Tail-spend rationalization.
 * Long tail of one-off / low-volume suppliers in non-strategic categories.
 */
export const tailSpendRationalizationLever: LeverAnalyzer = {
  leverId: "tail_spend_rationalization",
  tier: 1,
  label: "Tail-Spend Rationalization",
  description:
    "Long tail of one-off / low-volume suppliers in non-strategic categories. Consolidate to a managed-tail or P-card program.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      WITH supplier_spend AS (
        SELECT po.supplier_id,
               s.name AS supplier_name,
               s.is_strategic,
               SUM(po.total_usd::numeric) AS total_spend,
               COUNT(po.id) AS po_count
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.org_id = ${orgId}
          AND po.order_date >= NOW() - INTERVAL '365 days'
        GROUP BY po.supplier_id, s.name, s.is_strategic
      )
      SELECT
        COUNT(*) FILTER (WHERE total_spend < 25000 AND is_strategic = FALSE) AS tail_supplier_count,
        SUM(total_spend) FILTER (WHERE total_spend < 25000 AND is_strategic = FALSE) AS tail_spend
      FROM supplier_spend
    `);
    const r = rows.rows[0] as
      | { tail_supplier_count: string; tail_spend: string }
      | undefined;
    if (!r) return [];
    const tailCount = Number(r.tail_supplier_count ?? 0);
    const tailSpend = Number(r.tail_spend ?? 0);
    if (tailCount < 30 || tailSpend < 50_000) return [];
    // Conservative 12% on consolidation.
    const savings = tailSpend * 0.12;
    return [
      {
        leverId: "tail_spend_rationalization",
        title: `Consolidate ${tailCount} tail suppliers ($${(tailSpend / 1000).toFixed(0)}K) into a managed-tail program`,
        rationale: `${tailCount} non-strategic suppliers each below $25K annual spend together total $${tailSpend.toFixed(0)} per year — classic tail. Aggregating to a managed-tail / P-card program typically captures 10–15%.`,
        recommendedAction: `Stand up a managed-tail program (or P-card category for the smallest spend) and migrate the long tail; retire suppliers under $5K outright.`,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          tailSupplierCount: tailCount,
          tailSpendUsd: tailSpend,
          assumedSavingsPct: 12,
        },
      },
    ];
  },
};

export const TIER_1_LEVERS: LeverAnalyzer[] = [
  skuPriceBenchmarkLever,
  maverickSpendLever,
  contractLeakageLever,
  duplicatePaymentLever,
  missedVolumeThresholdLever,
  paymentTermExtensionLever,
  tailSpendRationalizationLever,
];
