import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "../types";

/**
 * Lever — SOW to MSA conversion (Tier 5).
 *
 * For each supplier with `>= 3` SOW-style contracts (`contractType in
 * (t_and_m, fixed_price, milestone, retainer, outcome)`) where every
 * row's `msaParentId` is NULL — i.e. no MSA umbrella exists — emit an
 * opportunity recommending consolidation under a fresh MSA.
 *
 * Skip suppliers that already have an MSA, defined as either:
 *   - a `goods` contract from that supplier (treated as the umbrella), or
 *   - a contract whose `id` is referenced by another contract's
 *     `msa_parent_id` (some other contract is already using it as MSA).
 *
 * Sized savings = `sum(annualBaselineUsd) * negotiationUpliftFactor`
 * (default 5%). Tenant-data only — no market signals consulted.
 */

const SOW_CONTRACT_TYPES = ["t_and_m", "fixed_price", "milestone", "retainer", "outcome"] as const;
const NEGOTIATION_UPLIFT = 0.05;
const MIN_CONTRACT_COUNT = 3;
const MIN_SAVINGS_USD = 1000;

const dollars = (n: number) => Math.round(n * 100) / 100;

interface CandidateRow {
  supplier_id: string;
  supplier_name: string;
  unhoused_count: string;
  total_baseline_usd: string;
  contract_numbers: string[];
}

export const sowToMsaConversionLever: LeverAnalyzer = {
  leverId: "sow_to_msa_conversion",
  tier: 5,
  label: "SOW to MSA Conversion",
  description:
    "Suppliers with 3+ unhoused SOW-style contracts (t_and_m / fixed_price / milestone / retainer / outcome) and no MSA umbrella. Recommends consolidation under a fresh MSA; sizes savings against the combined baseline at the default 5% negotiation uplift.",
  cohortKey(draft: OpportunityDraft): string {
    // Cohort identity is the supplier itself; supplierId is already on
    // draft.supplierId so the lever-key contribution is empty.
    void draft;
    return "";
  },
  async analyze({ orgId }) {
    const typesArr = `ARRAY[${SOW_CONTRACT_TYPES.map((t) => `'${t}'`).join(",")}]::text[]`;
    const rows = (await db.execute(sql`
      WITH supplier_contracts AS (
        SELECT c.supplier_id,
               c.id,
               c.contract_number,
               c.contract_type,
               c.msa_parent_id,
               COALESCE(c.annual_baseline_usd::numeric, 0) AS baseline
        FROM contracts c
        WHERE c.org_id = ${orgId}
          AND c.status = 'active'
      ),
      msa_used AS (
        -- Any contract id that is referenced as another contract's MSA parent.
        SELECT DISTINCT msa_parent_id AS id
        FROM supplier_contracts
        WHERE msa_parent_id IS NOT NULL
      ),
      supplier_has_msa AS (
        -- A supplier "already has an MSA" if either:
        --   (a) any of their contracts is contract_type='goods' (treated as umbrella), or
        --   (b) any of their contracts is referenced by another contract via msa_parent_id.
        SELECT DISTINCT sc.supplier_id
        FROM supplier_contracts sc
        WHERE sc.contract_type = 'goods'
           OR sc.id IN (SELECT id FROM msa_used)
      ),
      unhoused AS (
        SELECT sc.supplier_id,
               sc.contract_number,
               sc.baseline
        FROM supplier_contracts sc
        WHERE sc.contract_type = ANY(${sql.raw(typesArr)})
          AND sc.msa_parent_id IS NULL
          AND sc.supplier_id NOT IN (SELECT supplier_id FROM supplier_has_msa)
      )
      SELECT u.supplier_id,
             s.name AS supplier_name,
             COUNT(*)::text                                       AS unhoused_count,
             COALESCE(SUM(u.baseline), 0)::text                   AS total_baseline_usd,
             array_agg(u.contract_number ORDER BY u.contract_number) AS contract_numbers
      FROM unhoused u
      JOIN suppliers s ON s.id = u.supplier_id
      GROUP BY u.supplier_id, s.name
      HAVING COUNT(*) >= ${MIN_CONTRACT_COUNT}
    `)).rows as unknown as CandidateRow[];

    const drafts: OpportunityDraft[] = [];
    for (const r of rows) {
      const totalBaseline = Number(r.total_baseline_usd);
      const count = Number(r.unhoused_count);
      const savings = totalBaseline * NEGOTIATION_UPLIFT;
      if (savings < MIN_SAVINGS_USD) continue;
      const contractNumbers = r.contract_numbers ?? [];
      const summary =
        contractNumbers.length <= 5
          ? contractNumbers.join(", ")
          : `${contractNumbers.slice(0, 5).join(", ")}, …`;
      drafts.push({
        leverId: "sow_to_msa_conversion",
        title: `Roll up ${count} ${r.supplier_name} SOWs under a single MSA`,
        rationale: `${r.supplier_name} has ${count} active SOW-style contracts (${summary}) totalling $${totalBaseline.toFixed(0)} in annual baseline, with no MSA umbrella in place. Each engagement is being negotiated standalone — pricing, payment terms, IP, indemnity all renegotiated each time. A consolidated MSA captures volume leverage and removes per-SOW boilerplate friction.`,
        recommendedAction: `Negotiate a master services agreement covering all ${count} active engagements; target a ${(NEGOTIATION_UPLIFT * 100).toFixed(0)}% uplift on the combined baseline through a volume rebate, MFN clause, and standardized rate card.`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          supplierId: r.supplier_id,
          unhousedContractCount: count,
          contractNumbers,
          totalBaselineUsd: totalBaseline,
          negotiationUpliftFactor: NEGOTIATION_UPLIFT,
        },
      });
    }

    const result: AnalyzeResult = {
      drafts,
      consultedSignalIds: [],
      candidatesEvaluated: rows.length,
    };
    return result;
  },
};
