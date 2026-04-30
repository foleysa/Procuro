import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { LeverAnalyzer, OpportunityDraft } from "./types";

const dollars = (n: number) => Math.round(n * 100) / 100;

/**
 * Lever 8 — Supplier consolidation in indirect categories.
 * Multiple active suppliers in the same indirect category — consolidate.
 */
export const supplierConsolidationLever: LeverAnalyzer = {
  leverId: "supplier_consolidation",
  tier: 2,
  label: "Supplier Consolidation (Indirect)",
  description:
    "Multiple active suppliers in the same indirect category. Consolidate to the top 1–2 for volume leverage.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      WITH cat_suppliers AS (
        SELECT pol.category_id,
               cat.name AS category_name,
               cat.class AS category_class,
               po.supplier_id,
               s.name AS supplier_name,
               SUM(pol.extended_usd::numeric) AS supplier_spend
        FROM po_lines pol
        JOIN purchase_orders po ON po.id = pol.po_id
        JOIN suppliers s ON s.id = po.supplier_id
        JOIN categories cat ON cat.id = pol.category_id
        WHERE pol.org_id = ${orgId}
          AND cat.class = 'indirect'
          AND pol.order_date >= NOW() - INTERVAL '365 days'
        GROUP BY pol.category_id, cat.name, cat.class, po.supplier_id, s.name
      ),
      cat_summary AS (
        SELECT category_id,
               category_name,
               COUNT(DISTINCT supplier_id) AS supplier_count,
               SUM(supplier_spend) AS total_cat_spend
        FROM cat_suppliers
        GROUP BY category_id, category_name
        HAVING COUNT(DISTINCT supplier_id) >= 4
           AND SUM(supplier_spend) > 25000
      )
      SELECT * FROM cat_summary
      ORDER BY total_cat_spend DESC
      LIMIT 15
    `);
    const drafts: OpportunityDraft[] = [];
    for (const r of rows.rows as Array<{
      category_id: string;
      category_name: string;
      supplier_count: string;
      total_cat_spend: string;
    }>) {
      const totalSpend = Number(r.total_cat_spend);
      const supplierCount = Number(r.supplier_count);
      const savings = totalSpend * 0.06;
      drafts.push({
        leverId: "supplier_consolidation",
        title: `Consolidate ${supplierCount} ${r.category_name} suppliers`,
        rationale: `${r.category_name} indirect spend of $${totalSpend.toFixed(0)} is fragmented across ${supplierCount} active suppliers. Consolidating to the top 2 typically captures 5–8% via volume leverage.`,
        recommendedAction: `Run a sourcing event on ${r.category_name}; award to the top 2 suppliers with a primary/secondary split.`,
        categoryId: r.category_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          categoryId: r.category_id,
          supplierCount,
          totalCategorySpendUsd: totalSpend,
          assumedSavingsPct: 6,
        },
      });
    }
    return drafts;
  },
};

/**
 * Lever 9 — Contract renegotiation triggers.
 * Contracts expiring soon, or where actual volume has materially grown.
 */
export const contractRenegotiationTriggerLever: LeverAnalyzer = {
  leverId: "contract_renegotiation_trigger",
  tier: 2,
  label: "Contract Renegotiation Triggers",
  description:
    "Contracts expiring in <90 days or where actual volume has grown materially vs baseline. Renegotiate now while leverage is fresh.",
  async analyze({ orgId }) {
    const rows = await db.execute(sql`
      WITH actuals AS (
        SELECT pol.po_id, po.supplier_id, po.contract_id,
               SUM(pol.extended_usd::numeric) AS spend
        FROM po_lines pol
        JOIN purchase_orders po ON po.id = pol.po_id
        WHERE pol.org_id = ${orgId}
          AND pol.order_date >= NOW() - INTERVAL '365 days'
        GROUP BY pol.po_id, po.supplier_id, po.contract_id
      ),
      contract_actuals AS (
        SELECT contract_id, SUM(spend) AS actual_12mo_spend
        FROM actuals
        WHERE contract_id IS NOT NULL
        GROUP BY contract_id
      )
      SELECT c.id AS contract_id,
             c.contract_number,
             c.title,
             c.supplier_id,
             s.name AS supplier_name,
             c.end_date,
             c.annual_baseline_usd::numeric AS baseline,
             COALESCE(ca.actual_12mo_spend, 0) AS actual_12mo
      FROM contracts c
      JOIN suppliers s ON s.id = c.supplier_id
      LEFT JOIN contract_actuals ca ON ca.contract_id = c.id
      WHERE c.org_id = ${orgId}
        AND c.status = 'active'
        AND (
          c.end_date <= NOW() + INTERVAL '90 days'
          OR (c.annual_baseline_usd::numeric > 0 AND COALESCE(ca.actual_12mo_spend, 0) > c.annual_baseline_usd::numeric * 1.20)
        )
      ORDER BY c.end_date ASC
      LIMIT 15
    `);
    const drafts: OpportunityDraft[] = [];
    const now = Date.now();
    for (const r of rows.rows as Array<{
      contract_id: string;
      contract_number: string;
      title: string;
      supplier_id: string;
      supplier_name: string;
      end_date: string;
      baseline: string;
      actual_12mo: string;
    }>) {
      const actual = Number(r.actual_12mo);
      const baseline = Number(r.baseline);
      const expiringSoon =
        new Date(r.end_date).getTime() - now < 90 * 24 * 60 * 60 * 1000;
      const overran = baseline > 0 && actual > baseline * 1.2;
      const triggers: string[] = [];
      if (expiringSoon) triggers.push("expiring <90d");
      if (overran)
        triggers.push(
          `volume +${(((actual - baseline) / baseline) * 100).toFixed(0)}% vs baseline`,
        );
      // Conservative: 5% on actual.
      const savings = actual * 0.05;
      if (savings < 1000) continue;
      drafts.push({
        leverId: "contract_renegotiation_trigger",
        title: `Renegotiate ${r.contract_number} with ${r.supplier_name} (${triggers.join("; ")})`,
        rationale: `Contract ${r.contract_number} (${r.title}) — baseline $${baseline.toFixed(0)}, actual 12-mo $${actual.toFixed(0)}, end date ${new Date(r.end_date).toISOString().slice(0, 10)}. Triggers: ${triggers.join(", ")}.`,
        recommendedAction: `Open renewal negotiation now with volume leverage; secure tier breakpoint that captures next-12mo trajectory.`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          contractId: r.contract_id,
          supplierId: r.supplier_id,
          baselineUsd: baseline,
          actual12moUsd: actual,
          endDate: r.end_date,
          triggers,
          assumedSavingsPct: 5,
        },
      });
    }
    return drafts;
  },
};

export const TIER_2_LEVERS: LeverAnalyzer[] = [
  supplierConsolidationLever,
  contractRenegotiationTriggerLever,
];
