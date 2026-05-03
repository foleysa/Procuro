import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "../types";

/**
 * Lever — Unbundling / Rebundling (Tier 5).
 *
 * Two complementary detections folded into one lever; both look at
 * the *shape* of the services-spend portfolio rather than at the
 * commercial structure of any single contract.
 *
 *   1. **Rebundling (consolidation).** A single category has >= 3
 *      active services-style contracts (`contractType in (t_and_m,
 *      fixed_price, milestone, retainer, outcome)`) across >= 2
 *      distinct suppliers, with a combined baseline >= $200k. The
 *      buyer is fragmenting demand across multiple firms in the same
 *      category — consolidation captures volume leverage. Sized at
 *      `combined_baseline * REBUNDLE_UPLIFT` (default 5%).
 *
 *   2. **Unbundling (split for competition).** A single supplier holds
 *      >= 2 active services contracts spanning >= 2 distinct
 *      categories with a combined baseline >= $500k. The supplier is
 *      acting as a one-stop shop across uncorrelated towers — splitting
 *      the work for competitive bidding usually reveals that a
 *      specialist beats the generalist on each tower individually.
 *      Sized at `combined_baseline * UNBUNDLE_UPLIFT` (default 4%).
 *
 * Tenant-data only — no market signals consulted.
 */

const REBUNDLE_MIN_CONTRACTS = 3;
const REBUNDLE_MIN_SUPPLIERS = 2;
const REBUNDLE_MIN_BASELINE_USD = 200_000;
const REBUNDLE_UPLIFT = 0.05;

const UNBUNDLE_MIN_CONTRACTS = 2;
const UNBUNDLE_MIN_CATEGORIES = 2;
const UNBUNDLE_MIN_BASELINE_USD = 500_000;
const UNBUNDLE_UPLIFT = 0.04;

const MIN_SAVINGS_USD = 1000;

const SERVICES_CONTRACT_TYPES = [
  "t_and_m",
  "fixed_price",
  "milestone",
  "retainer",
  "outcome",
] as const;

const dollars = (n: number) => Math.round(n * 100) / 100;

interface RebundleRow {
  category_id: string;
  category_code: string;
  category_name: string;
  contract_count: string;
  supplier_count: string;
  combined_baseline_usd: string;
  supplier_names: string[];
  contract_numbers: string[];
}

interface UnbundleRow {
  supplier_id: string;
  supplier_name: string;
  contract_count: string;
  category_count: string;
  combined_baseline_usd: string;
  category_codes: string[];
  category_names: string[];
  contract_numbers: string[];
}

export const unbundlingRebundlingLever: LeverAnalyzer = {
  leverId: "unbundling_rebundling",
  tier: 5,
  label: "Unbundling / Rebundling",
  description:
    "Detects services-portfolio shape opportunities. Rebundling: 3+ contracts in one category across 2+ suppliers (consolidate). Unbundling: 2+ contracts spanning 2+ categories with one supplier and $500k+ combined baseline (split for competitive bidding). Sizes against combined baseline at category-appropriate uplift factors.",
  cohortKey(draft: OpportunityDraft): string {
    // Cohort identity:
    //   - rebundle drafts: categoryId (already on draft.categoryId)
    //   - unbundle drafts: supplierId (already on draft.supplierId)
    // The lever-key contribution distinguishes the flavour so the
    // two never collide in the cohort namespace.
    const inputs = (draft.inputs as Record<string, unknown>) ?? {};
    const flavour = inputs["flavour"];
    return typeof flavour === "string" ? flavour : "";
  },
  async analyze({ orgId }) {
    const typesArr = `ARRAY[${SERVICES_CONTRACT_TYPES.map((t) => `'${t}'`).join(",")}]::text[]`;

    // 1. Rebundle: many contracts / many suppliers in a single category.
    const rebundleRows = (await db.execute(sql`
      SELECT c.category_id,
             cat.code                         AS category_code,
             cat.name                         AS category_name,
             COUNT(*)::text                   AS contract_count,
             COUNT(DISTINCT c.supplier_id)::text AS supplier_count,
             COALESCE(SUM(c.annual_baseline_usd::numeric), 0)::text
                                              AS combined_baseline_usd,
             array_agg(DISTINCT s.name ORDER BY s.name)
                                              AS supplier_names,
             array_agg(c.contract_number ORDER BY c.contract_number)
                                              AS contract_numbers
      FROM contracts c
      JOIN categories cat ON cat.id = c.category_id
      JOIN suppliers s ON s.id = c.supplier_id
      WHERE c.org_id = ${orgId}
        AND c.status = 'active'
        AND c.category_id IS NOT NULL
        AND c.contract_type = ANY(${sql.raw(typesArr)})
      GROUP BY c.category_id, cat.code, cat.name
      HAVING COUNT(*) >= ${REBUNDLE_MIN_CONTRACTS}
         AND COUNT(DISTINCT c.supplier_id) >= ${REBUNDLE_MIN_SUPPLIERS}
         AND COALESCE(SUM(c.annual_baseline_usd::numeric), 0) >= ${REBUNDLE_MIN_BASELINE_USD}
    `)).rows as unknown as RebundleRow[];

    const drafts: OpportunityDraft[] = [];

    for (const r of rebundleRows) {
      const combined = Number(r.combined_baseline_usd);
      const contractCount = Number(r.contract_count);
      const supplierCount = Number(r.supplier_count);
      const savings = combined * REBUNDLE_UPLIFT;
      if (savings < MIN_SAVINGS_USD) continue;
      const suppliers = r.supplier_names ?? [];
      const supplierSummary =
        suppliers.length <= 4
          ? suppliers.join(", ")
          : `${suppliers.slice(0, 4).join(", ")}, +${suppliers.length - 4} more`;
      drafts.push({
        leverId: "unbundling_rebundling",
        title: `Consolidate ${r.category_name} services across ${supplierCount} suppliers (${contractCount} active contracts)`,
        rationale: `${r.category_name} (code ${r.category_code}) currently runs ${contractCount} active services-style contracts across ${supplierCount} distinct suppliers (${supplierSummary}), with a combined annual baseline of $${combined.toFixed(0)}. Demand is fragmented across multiple firms doing similar work — consolidation through a competitive RFP captures volume leverage and reduces vendor-management overhead. Default uplift ${(REBUNDLE_UPLIFT * 100).toFixed(0)}% on combined baseline.`,
        recommendedAction: `Run a competitive consolidation RFP for ${r.category_name}: target reducing the panel to 1-2 suppliers, anchor on a tiered volume rebate, and move the displaced spend onto the winning paper at the next renewal window.`,
        categoryId: r.category_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          flavour: "rebundle",
          categoryId: r.category_id,
          categoryCode: r.category_code,
          contractCount,
          supplierCount,
          supplierNames: suppliers,
          contractNumbers: r.contract_numbers ?? [],
          combinedBaselineUsd: combined,
          rebundleUpliftFactor: REBUNDLE_UPLIFT,
          minContractsThreshold: REBUNDLE_MIN_CONTRACTS,
          minSuppliersThreshold: REBUNDLE_MIN_SUPPLIERS,
          minBaselineThresholdUsd: REBUNDLE_MIN_BASELINE_USD,
        },
      });
    }

    // 2. Unbundle: one supplier spanning many categories.
    const unbundleRows = (await db.execute(sql`
      SELECT c.supplier_id,
             s.name                                AS supplier_name,
             COUNT(*)::text                        AS contract_count,
             COUNT(DISTINCT c.category_id)::text   AS category_count,
             COALESCE(SUM(c.annual_baseline_usd::numeric), 0)::text
                                                   AS combined_baseline_usd,
             array_agg(DISTINCT cat.code ORDER BY cat.code)
                                                   AS category_codes,
             array_agg(DISTINCT cat.name ORDER BY cat.name)
                                                   AS category_names,
             array_agg(c.contract_number ORDER BY c.contract_number)
                                                   AS contract_numbers
      FROM contracts c
      JOIN suppliers s ON s.id = c.supplier_id
      JOIN categories cat ON cat.id = c.category_id
      WHERE c.org_id = ${orgId}
        AND c.status = 'active'
        AND c.category_id IS NOT NULL
        AND c.contract_type = ANY(${sql.raw(typesArr)})
      GROUP BY c.supplier_id, s.name
      HAVING COUNT(*) >= ${UNBUNDLE_MIN_CONTRACTS}
         AND COUNT(DISTINCT c.category_id) >= ${UNBUNDLE_MIN_CATEGORIES}
         AND COALESCE(SUM(c.annual_baseline_usd::numeric), 0) >= ${UNBUNDLE_MIN_BASELINE_USD}
    `)).rows as unknown as UnbundleRow[];

    for (const r of unbundleRows) {
      const combined = Number(r.combined_baseline_usd);
      const contractCount = Number(r.contract_count);
      const categoryCount = Number(r.category_count);
      const savings = combined * UNBUNDLE_UPLIFT;
      if (savings < MIN_SAVINGS_USD) continue;
      const categories = r.category_names ?? [];
      const categorySummary =
        categories.length <= 4
          ? categories.join(", ")
          : `${categories.slice(0, 4).join(", ")}, +${categories.length - 4} more`;
      drafts.push({
        leverId: "unbundling_rebundling",
        title: `Split ${r.supplier_name} services across ${categoryCount} categories for competitive bidding`,
        rationale: `${r.supplier_name} holds ${contractCount} active services-style contracts spanning ${categoryCount} distinct categories (${categorySummary}) with a combined annual baseline of $${combined.toFixed(0)}. A single firm acting as a generalist across uncorrelated towers usually loses to specialists on each tower individually. Default uplift ${(UNBUNDLE_UPLIFT * 100).toFixed(0)}% on combined baseline once the work is split for competitive bidding.`,
        recommendedAction: `Carve the ${r.supplier_name} portfolio into per-category lots and run a sealed-bid RFP per lot at the next renewal window; allow the incumbent to bid each lot but require specialist competitors at the table for every tower above $100k.`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          flavour: "unbundle",
          supplierId: r.supplier_id,
          contractCount,
          categoryCount,
          categoryCodes: r.category_codes ?? [],
          categoryNames: categories,
          contractNumbers: r.contract_numbers ?? [],
          combinedBaselineUsd: combined,
          unbundleUpliftFactor: UNBUNDLE_UPLIFT,
          minContractsThreshold: UNBUNDLE_MIN_CONTRACTS,
          minCategoriesThreshold: UNBUNDLE_MIN_CATEGORIES,
          minBaselineThresholdUsd: UNBUNDLE_MIN_BASELINE_USD,
        },
      });
    }

    const result: AnalyzeResult = {
      drafts,
      consultedSignalIds: [],
      candidatesEvaluated: rebundleRows.length + unbundleRows.length,
    };
    return result;
  },
};
