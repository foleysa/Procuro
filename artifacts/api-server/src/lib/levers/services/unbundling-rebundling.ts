import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "../types";
import { mapRoleToScopeCategory } from "./role-soc-mapping";

/**
 * Lever — Services unbundling / rebundling (Tier 5, task #242).
 *
 * Two complementary detections fold into a single lever, both
 * computed off `time_entries` over the trailing 12 months and joined
 * to the role→SOC mapping (`role-soc-mapping.ts`):
 *
 *   1. **Rebundle (consolidate).** For each scope-category (the
 *      canonical role grouping the OEWS collector publishes wages
 *      against), if `>= REBUNDLE_MIN_SUPPLIERS` distinct suppliers
 *      are billing against that category and the combined trailing-12
 *      spend clears `REBUNDLE_MIN_SPEND_USD`, emit a category-level
 *      draft recommending consolidation onto a single preferred
 *      supplier. Sized at `REBUNDLE_UPLIFT` (7%) on the combined
 *      spend — the canonical volume-leverage assumption.
 *   2. **Unbundle (split).** For each supplier with `>=
 *      UNBUNDLE_MIN_ROLES` distinct mapped roles AND trailing-12
 *      spend `>= UNBUNDLE_MIN_SPEND_USD`, emit a supplier-level
 *      draft recommending the long-tail (bottom-half by spend) roles
 *      be re-sourced to specialty providers. Sized at
 *      `UNBUNDLE_UPLIFT` (5%) on the long-tail spend only.
 *
 * Tenant-data only — no market signals consulted.
 */

const REBUNDLE_MIN_SUPPLIERS = 3;
const REBUNDLE_MIN_SPEND_USD = 25_000;
const REBUNDLE_UPLIFT = 0.07;

const UNBUNDLE_MIN_ROLES = 5;
const UNBUNDLE_MIN_SPEND_USD = 250_000;
const UNBUNDLE_UPLIFT = 0.05;

const MIN_SAVINGS_USD = 1_000;

const dollars = (n: number) => Math.round(n * 100) / 100;

interface RoleSpendRow {
  supplier_id: string;
  supplier_name: string;
  role: string;
  total_spend_usd: string;
}

export const unbundlingRebundlingLever: LeverAnalyzer = {
  leverId: "unbundling_rebundling",
  tier: 5,
  label: "Services Unbundling / Rebundling",
  description:
    "Two flavours folded into one lever: rebundle (consolidate when >=3 suppliers cover the same role-category with combined trailing-12 spend >=$25k) and unbundle (split when one supplier covers >=5 distinct roles with >=$250k trailing-12 spend). Sizes savings against canonical 7% / 5% uplifts.",
  cohortKey(draft: OpportunityDraft): string {
    const inputs = (draft.inputs as Record<string, unknown>) ?? {};
    const flavor = inputs["flavor"];
    if (flavor === "rebundle") {
      const code = inputs["scopeCategoryCode"];
      return `rebundle:${typeof code === "string" ? code : ""}`;
    }
    if (flavor === "unbundle") {
      // supplierId is already on draft.supplierId so the lever-key
      // contribution is just the flavor discriminator.
      return "unbundle";
    }
    return "";
  },
  async analyze({ orgId }) {
    // Pull (supplier, role) trailing-12 spend buckets in a single
    // query, then map roles to scope categories in JS so the SOC
    // mapping table stays the single source of truth.
    const rows = (await db.execute(sql`
      SELECT te.supplier_id,
             s.name AS supplier_name,
             te.role,
             COALESCE(SUM(te.amount_usd::numeric), 0)::text AS total_spend_usd
      FROM time_entries te
      JOIN suppliers s ON s.id = te.supplier_id
      WHERE te.org_id = ${orgId}
        AND te.role IS NOT NULL
        AND te.work_date >= NOW() - INTERVAL '365 days'
      GROUP BY te.supplier_id, s.name, te.role
      HAVING COALESCE(SUM(te.amount_usd::numeric), 0) > 0
    `)).rows as unknown as RoleSpendRow[];

    interface RoleEntry {
      role: string;
      scopeCategoryCode: string | null;
      scopeCategoryLabel: string | null;
      spend: number;
    }
    const bySupplier = new Map<
      string,
      { name: string; roles: RoleEntry[] }
    >();
    interface CategorySupplierEntry {
      supplierId: string;
      supplierName: string;
      spend: number;
      role: string;
    }
    const byCategory = new Map<
      string,
      { label: string; suppliers: Map<string, CategorySupplierEntry> }
    >();

    for (const r of rows) {
      const spend = Number(r.total_spend_usd);
      if (!isFinite(spend) || spend <= 0) continue;
      const match = mapRoleToScopeCategory(r.role);
      const entry: RoleEntry = {
        role: r.role,
        scopeCategoryCode: match?.scopeCategoryCode ?? null,
        scopeCategoryLabel: match?.label ?? null,
        spend,
      };
      const sup = bySupplier.get(r.supplier_id);
      if (sup) {
        sup.roles.push(entry);
      } else {
        bySupplier.set(r.supplier_id, {
          name: r.supplier_name,
          roles: [entry],
        });
      }

      if (match) {
        let cat = byCategory.get(match.scopeCategoryCode);
        if (!cat) {
          cat = { label: match.label, suppliers: new Map() };
          byCategory.set(match.scopeCategoryCode, cat);
        }
        const existing = cat.suppliers.get(r.supplier_id);
        if (existing) {
          existing.spend += spend;
        } else {
          cat.suppliers.set(r.supplier_id, {
            supplierId: r.supplier_id,
            supplierName: r.supplier_name,
            spend,
            role: r.role,
          });
        }
      }
    }

    const drafts: OpportunityDraft[] = [];

    // 1. Rebundle (consolidate) — category-level drafts.
    for (const [code, cat] of byCategory) {
      if (cat.suppliers.size < REBUNDLE_MIN_SUPPLIERS) continue;
      const suppliers = Array.from(cat.suppliers.values()).sort(
        (a, b) => b.spend - a.spend,
      );
      const totalSpend = suppliers.reduce((sum, x) => sum + x.spend, 0);
      if (totalSpend < REBUNDLE_MIN_SPEND_USD) continue;
      const savings = totalSpend * REBUNDLE_UPLIFT;
      if (savings < MIN_SAVINGS_USD) continue;
      const top = suppliers[0]!;

      drafts.push({
        leverId: "unbundling_rebundling",
        title: `Consolidate ${suppliers.length} suppliers covering ${cat.label} onto a single preferred provider`,
        rationale: `${suppliers.length} active suppliers billed against ${cat.label} over the trailing 12 months for a combined spend of $${totalSpend.toFixed(0)}. Top spender is ${top.supplierName} at $${top.spend.toFixed(0)} (${((top.spend / totalSpend) * 100).toFixed(0)}% share). Splitting the same role across this many suppliers fragments volume leverage and forces parallel onboarding/governance overhead on the buyer.`,
        recommendedAction: `Run a consolidation event: anchor on ${top.supplierName} (or a fresh RFP among the top 2) and target a ${(REBUNDLE_UPLIFT * 100).toFixed(0)}% volume rebate on the combined $${totalSpend.toFixed(0)} baseline. Phase off the long-tail suppliers as their current SOWs close.`,
        // Category-level draft — no single supplier owner.
        supplierId: null,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          flavor: "rebundle",
          scopeCategoryCode: code,
          scopeCategoryLabel: cat.label,
          supplierCount: suppliers.length,
          totalSpend12moUsd: totalSpend,
          rebundleUpliftFactor: REBUNDLE_UPLIFT,
          minSupplierCount: REBUNDLE_MIN_SUPPLIERS,
          minSpendUsd: REBUNDLE_MIN_SPEND_USD,
          topSuppliers: suppliers.slice(0, 5).map((s) => ({
            supplierId: s.supplierId,
            supplierName: s.supplierName,
            spendUsd: dollars(s.spend),
          })),
        },
      });
    }

    // 2. Unbundle (split) — supplier-level drafts.
    for (const [supplierId, sup] of bySupplier) {
      // Distinct *mapped* roles only — un-mapped role labels are
      // ambiguous and shouldn't anchor an unbundle recommendation.
      const mapped = sup.roles.filter((r) => r.scopeCategoryCode !== null);
      const distinctCategories = new Set(
        mapped.map((r) => r.scopeCategoryCode!),
      );
      if (distinctCategories.size < UNBUNDLE_MIN_ROLES) continue;

      const totalSpend = sup.roles.reduce((sum, r) => sum + r.spend, 0);
      if (totalSpend < UNBUNDLE_MIN_SPEND_USD) continue;

      // Long-tail = bottom half of mapped roles ranked by spend.
      const sorted = [...mapped].sort((a, b) => b.spend - a.spend);
      const tailStart = Math.ceil(sorted.length / 2);
      const tail = sorted.slice(tailStart);
      const tailSpend = tail.reduce((sum, r) => sum + r.spend, 0);
      if (tailSpend <= 0) continue;

      const savings = tailSpend * UNBUNDLE_UPLIFT;
      if (savings < MIN_SAVINGS_USD) continue;

      drafts.push({
        leverId: "unbundling_rebundling",
        title: `Unbundle long-tail roles from ${sup.name} (${distinctCategories.size} distinct role categories)`,
        rationale: `${sup.name} billed across ${distinctCategories.size} distinct mapped role categories over the trailing 12 months for a combined $${totalSpend.toFixed(0)}. The long-tail (bottom ${tail.length} of ${sorted.length} categories by spend) accounts for $${tailSpend.toFixed(0)}. A generalist holding this much breadth is rarely best-of-breed on every role — specialty providers typically price the long-tail roles below the generalist's blended rate.`,
        recommendedAction: `Re-source the long-tail roles (${tail.map((r) => r.scopeCategoryLabel).filter((l): l is string => !!l).slice(0, 5).join(", ")}${tail.length > 5 ? ", …" : ""}) to specialty providers; target a ${(UNBUNDLE_UPLIFT * 100).toFixed(0)}% rate reduction on the $${tailSpend.toFixed(0)} long-tail spend while keeping ${sup.name} as the prime on the top categories.`,
        supplierId,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          flavor: "unbundle",
          supplierId,
          distinctRoleCategoryCount: distinctCategories.size,
          totalSpend12moUsd: totalSpend,
          longTailSpendUsd: tailSpend,
          longTailRoleCount: tail.length,
          unbundleUpliftFactor: UNBUNDLE_UPLIFT,
          minRoleCount: UNBUNDLE_MIN_ROLES,
          minSpendUsd: UNBUNDLE_MIN_SPEND_USD,
          longTailRoles: tail.slice(0, 10).map((r) => ({
            role: r.role,
            scopeCategoryCode: r.scopeCategoryCode,
            scopeCategoryLabel: r.scopeCategoryLabel,
            spendUsd: dollars(r.spend),
          })),
        },
      });
    }

    const result: AnalyzeResult = {
      drafts,
      consultedSignalIds: [],
      candidatesEvaluated: bySupplier.size + byCategory.size,
    };
    return result;
  },
};
