import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "../types";

/**
 * Lever — Outcome-based contract conversion (Tier 5, task #242).
 *
 * Identifies active `t_and_m` or `retainer` contracts that have
 * demonstrated a repeatable engagement cadence (and therefore a
 * stable enough output that the work could be repriced as a fixed
 * outcome / deliverable rather than billed against rate-card hours).
 *
 * Trigger conditions (all must hold):
 *   - `contract.status = 'active'`
 *   - `contract.contractType IN ('t_and_m', 'retainer')` — i.e. NOT
 *     already on an outcome / milestone / fixed-price structure.
 *   - `annual_baseline_usd >= MIN_BASELINE_USD` ($50k) — small
 *     engagements aren't worth the renegotiation effort.
 *   - Repeatability evidence — at least one of:
 *       a) `>= 2` SOWs under the contract whose status is
 *          `completed` or `active` (a proven cadence of work
 *          packages), OR
 *       b) `>= 270` days span between the earliest and latest
 *          `time_entries.work_date` for the contract — i.e. nine
 *          months of continuous engagement.
 *
 * Sized savings = `annual_baseline_usd * OUTCOME_UPLIFT` (default
 * 10%) — the canonical industry assumption for moving from T&M to
 * outcome pricing on a stable workload.
 *
 * Tenant-data only — no market signals consulted.
 */

const ELIGIBLE_CONTRACT_TYPES = ["t_and_m", "retainer"] as const;
const MIN_BASELINE_USD = 50_000;
const OUTCOME_UPLIFT = 0.10;
const MIN_SOW_COUNT = 2;
const MIN_ENGAGEMENT_DAYS = 270;
const MIN_SAVINGS_USD = 1_000;

const dollars = (n: number) => Math.round(n * 100) / 100;

interface CandidateRow {
  contract_id: string;
  contract_number: string;
  contract_title: string;
  contract_type: string;
  supplier_id: string;
  supplier_name: string;
  annual_baseline_usd: string;
  sow_count: string;
  engagement_days: string | null;
  total_burn_12mo_usd: string;
}

export const outcomeBasedContractLever: LeverAnalyzer = {
  leverId: "outcome_based_contract",
  tier: 5,
  label: "Outcome-Based Contract Conversion",
  description:
    "Active T&M or retainer contracts with proven engagement cadence (>=2 SOWs or >=9 months of continuous time entries) and >=$50k annual baseline. Recommends repricing as outcome-based / fixed-deliverable; sizes savings against the 10% canonical uplift on the annual baseline.",
  cohortKey(draft: OpportunityDraft): string {
    const inputs = (draft.inputs as Record<string, unknown>) ?? {};
    const id = inputs["contractId"];
    return typeof id === "string" ? id : "";
  },
  async analyze({ orgId }) {
    const typesArr = `ARRAY[${ELIGIBLE_CONTRACT_TYPES.map((t) => `'${t}'`).join(",")}]::text[]`;
    const rows = (await db.execute(sql`
      WITH sow_agg AS (
        SELECT sow.contract_id,
               COUNT(*) FILTER (WHERE sow.status IN ('active', 'completed'))::text AS sow_count
        FROM statements_of_work sow
        WHERE sow.org_id = ${orgId}
        GROUP BY sow.contract_id
      ),
      te_agg AS (
        SELECT te.contract_id,
               (EXTRACT(EPOCH FROM (MAX(te.work_date) - MIN(te.work_date))) / 86400)::text AS engagement_days,
               COALESCE(SUM(CASE WHEN te.work_date >= NOW() - INTERVAL '365 days'
                                 THEN te.amount_usd::numeric ELSE 0 END), 0)::text AS total_burn_12mo
        FROM time_entries te
        WHERE te.org_id = ${orgId}
          AND te.contract_id IS NOT NULL
        GROUP BY te.contract_id
      )
      SELECT c.id              AS contract_id,
             c.contract_number,
             c.title            AS contract_title,
             c.contract_type,
             c.supplier_id,
             s.name             AS supplier_name,
             COALESCE(c.annual_baseline_usd, '0')::text AS annual_baseline_usd,
             COALESCE(sow_agg.sow_count, '0')           AS sow_count,
             te_agg.engagement_days                     AS engagement_days,
             COALESCE(te_agg.total_burn_12mo, '0')      AS total_burn_12mo_usd
      FROM contracts c
      JOIN suppliers s ON s.id = c.supplier_id
      LEFT JOIN sow_agg ON sow_agg.contract_id = c.id
      LEFT JOIN te_agg  ON te_agg.contract_id  = c.id
      WHERE c.org_id = ${orgId}
        AND c.status = 'active'
        AND c.contract_type = ANY(${sql.raw(typesArr)})
    `)).rows as unknown as CandidateRow[];

    const drafts: OpportunityDraft[] = [];
    for (const r of rows) {
      const baseline = Number(r.annual_baseline_usd);
      if (!isFinite(baseline) || baseline < MIN_BASELINE_USD) continue;

      const sowCount = Number(r.sow_count);
      const engagementDays = r.engagement_days
        ? Math.max(0, Number(r.engagement_days))
        : 0;
      const burn12mo = Math.max(0, Number(r.total_burn_12mo_usd) || 0);

      const sowTrigger = sowCount >= MIN_SOW_COUNT;
      const tenureTrigger = engagementDays >= MIN_ENGAGEMENT_DAYS;
      if (!sowTrigger && !tenureTrigger) continue;

      const savings = baseline * OUTCOME_UPLIFT;
      if (savings < MIN_SAVINGS_USD) continue;

      const triggerLabel = sowTrigger
        ? `${sowCount} SOWs delivered under this contract`
        : `${engagementDays.toFixed(0)} days of continuous engagement`;

      drafts.push({
        leverId: "outcome_based_contract",
        title: `Convert ${r.contract_type === "retainer" ? "retainer" : "T&M"} contract ${r.contract_number} (${r.supplier_name}) to outcome-based pricing`,
        rationale: `Contract ${r.contract_number} ("${r.contract_title}") with ${r.supplier_name} bills as ${r.contract_type} against an annual baseline of $${baseline.toFixed(0)}. Repeatability evidence: ${triggerLabel}${burn12mo > 0 ? `; trailing-12 actual burn $${burn12mo.toFixed(0)}` : ""}. A workload this stable can be repriced as a fixed outcome / deliverable so the supplier carries the productivity risk instead of the buyer paying for every hour.`,
        recommendedAction: `Open a renegotiation: anchor the next renewal on a fixed quarterly or per-deliverable price targeting a ${(OUTCOME_UPLIFT * 100).toFixed(0)}% reduction vs. the current baseline. Use the trailing engagement history to size the deliverable scope and bake quality SLAs into the acceptance criteria.`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          contractId: r.contract_id,
          contractNumber: r.contract_number,
          contractType: r.contract_type,
          supplierId: r.supplier_id,
          annualBaselineUsd: baseline,
          sowCount,
          engagementDays,
          totalBurn12moUsd: burn12mo,
          triggerKind: sowTrigger ? "sow_cadence" : "engagement_tenure",
          minSowCount: MIN_SOW_COUNT,
          minEngagementDays: MIN_ENGAGEMENT_DAYS,
          outcomeUpliftFactor: OUTCOME_UPLIFT,
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
