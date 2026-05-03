import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "../types";

/**
 * Lever — Outcome-based contract conversion (Tier 5).
 *
 * Surfaces services-side engagements that are mature enough — and
 * predictable enough — to convert from `t_and_m` / `fixed_price` /
 * `milestone` commercials to an `outcome` / success-fee structure,
 * which structurally aligns supplier incentives with the buyer's
 * realised value rather than hours billed.
 *
 * Two trigger conditions, ANDed per (supplier, contract):
 *
 *   1. **Material spend.** The contract's `annualBaselineUsd` is
 *      >= MIN_BASELINE_USD ($250k by default), so the conversion is
 *      worth the legal/commercial lift.
 *   2. **Predictable cadence.** The supplier has shown a stable
 *      monthly burn over the trailing 6 months — coefficient of
 *      variation (`stddev / mean`) on monthly time-entry spend
 *      <= MAX_COEFFICIENT_OF_VARIATION (0.35). A predictable run-rate
 *      means scope is well understood, which is the gate for being
 *      able to define outcomes upfront.
 *
 * Skip when the contract is already `outcome`-typed.
 *
 * Sized savings = `annualBaselineUsd * OUTCOME_CONVERSION_UPLIFT`
 * (default 8%). Industry research on outcome-based services pricing
 * (Accenture, ISG) consistently bands the realised buyer-side savings
 * at 5-12%; we anchor the midpoint and let calibration tune.
 *
 * Tenant-data only — no market signals consulted.
 */

const MIN_BASELINE_USD = 250_000;
const MAX_COEFFICIENT_OF_VARIATION = 0.35;
const MIN_MONTHS_OBSERVED = 4;
const OUTCOME_CONVERSION_UPLIFT = 0.08;
const MIN_SAVINGS_USD = 1000;

const dollars = (n: number) => Math.round(n * 100) / 100;

/** Convertible commercial structures — `outcome` is the target, not the source. */
const SOURCE_CONTRACT_TYPES = ["t_and_m", "fixed_price", "milestone", "retainer"] as const;

interface CandidateRow {
  contract_id: string;
  contract_number: string;
  contract_title: string;
  contract_type: string;
  supplier_id: string;
  supplier_name: string;
  annual_baseline_usd: string;
  monthly_spend_usd: string[];
  months_observed: string;
  total_spend_usd: string;
}

export const outcomeBasedContractLever: LeverAnalyzer = {
  leverId: "outcome_based_contract",
  tier: 5,
  label: "Outcome-Based Contract Conversion",
  description:
    "Active T&M / fixed-price / milestone / retainer engagements with material annual baseline ($250k+) and a predictable monthly burn cadence (CoV <= 0.35) over the trailing 6 months. These are mature enough to convert to an outcome-based commercial; sizes savings against the default 8% conversion uplift.",
  cohortKey(draft: OpportunityDraft): string {
    // Cohort identity is the contract itself; supplierId already lives
    // on draft.supplierId, so the lever-key contribution is the
    // contract id so re-runs collapse to a single cohort per contract.
    const inputs = (draft.inputs as Record<string, unknown>) ?? {};
    const id = inputs["contractId"];
    return typeof id === "string" ? id : "";
  },
  async analyze({ orgId }) {
    const typesArr = `ARRAY[${SOURCE_CONTRACT_TYPES.map((t) => `'${t}'`).join(",")}]::text[]`;
    const rows = (await db.execute(sql`
      WITH monthly AS (
        SELECT te.contract_id,
               date_trunc('month', te.work_date) AS month,
               COALESCE(SUM(te.amount_usd::numeric), 0) AS spend
        FROM time_entries te
        WHERE te.org_id = ${orgId}
          AND te.contract_id IS NOT NULL
          AND te.work_date >= NOW() - INTERVAL '180 days'
        GROUP BY te.contract_id, date_trunc('month', te.work_date)
      ),
      agg AS (
        SELECT contract_id,
               array_agg(spend::text ORDER BY month) AS monthly_spend,
               COUNT(*)                              AS months_observed,
               COALESCE(SUM(spend), 0)               AS total_spend
        FROM monthly
        GROUP BY contract_id
      )
      SELECT c.id                          AS contract_id,
             c.contract_number,
             c.title                       AS contract_title,
             c.contract_type,
             c.supplier_id,
             s.name                        AS supplier_name,
             COALESCE(c.annual_baseline_usd, 0)::text AS annual_baseline_usd,
             COALESCE(agg.monthly_spend, ARRAY[]::text[]) AS monthly_spend_usd,
             COALESCE(agg.months_observed, 0)::text       AS months_observed,
             COALESCE(agg.total_spend, 0)::text           AS total_spend_usd
      FROM contracts c
      JOIN suppliers s ON s.id = c.supplier_id
      LEFT JOIN agg ON agg.contract_id = c.id
      WHERE c.org_id = ${orgId}
        AND c.status = 'active'
        AND c.contract_type = ANY(${sql.raw(typesArr)})
        AND COALESCE(c.annual_baseline_usd, 0)::numeric >= ${MIN_BASELINE_USD}
    `)).rows as unknown as CandidateRow[];

    const drafts: OpportunityDraft[] = [];
    for (const r of rows) {
      const baseline = Number(r.annual_baseline_usd);
      if (!isFinite(baseline) || baseline < MIN_BASELINE_USD) continue;

      const monthly = (r.monthly_spend_usd ?? [])
        .map((v) => Number(v))
        .filter((v) => isFinite(v) && v >= 0);
      const monthsObserved = Number(r.months_observed);
      if (
        !isFinite(monthsObserved) ||
        monthsObserved < MIN_MONTHS_OBSERVED ||
        monthly.length < MIN_MONTHS_OBSERVED
      ) {
        continue;
      }
      const mean = monthly.reduce((s, v) => s + v, 0) / monthly.length;
      if (mean <= 0) continue;
      const variance =
        monthly.reduce((s, v) => s + (v - mean) ** 2, 0) / monthly.length;
      const stddev = Math.sqrt(variance);
      const cov = stddev / mean;
      if (!isFinite(cov) || cov > MAX_COEFFICIENT_OF_VARIATION) continue;

      const savings = baseline * OUTCOME_CONVERSION_UPLIFT;
      if (savings < MIN_SAVINGS_USD) continue;

      drafts.push({
        leverId: "outcome_based_contract",
        title: `Convert ${r.supplier_name} ${r.contract_number} (${r.contract_type}) to outcome-based pricing`,
        rationale: `${r.supplier_name} engagement ${r.contract_number} ("${r.contract_title}") is currently structured as ${r.contract_type} with $${baseline.toFixed(0)} annual baseline. Trailing-6 monthly burn averaged $${mean.toFixed(0)} across ${monthly.length} months with stddev $${stddev.toFixed(0)} (coefficient of variation ${cov.toFixed(2)} <= ${MAX_COEFFICIENT_OF_VARIATION}). Stable cadence at this scale means the scope and effort profile are predictable enough to define outcome triggers; conversion to a success-fee / outcome-based commercial captures the principal-agent waste in hours-billed contracts (industry-cited 5-12% range, anchored at ${(OUTCOME_CONVERSION_UPLIFT * 100).toFixed(0)}%).`,
        recommendedAction: `Open a commercial review with ${r.supplier_name}: define 2-3 measurable outcome triggers (delivery dates, throughput, quality SLAs) and price them at ${(100 - OUTCOME_CONVERSION_UPLIFT * 100).toFixed(0)}% of current baseline + a success-fee tied to the triggers. Pilot on the next renewal window before rolling across the relationship.`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          contractId: r.contract_id,
          contractNumber: r.contract_number,
          contractType: r.contract_type,
          supplierId: r.supplier_id,
          annualBaselineUsd: baseline,
          monthlySpendUsd: monthly,
          monthsObserved: monthly.length,
          monthlyMeanUsd: mean,
          monthlyStddevUsd: stddev,
          coefficientOfVariation: cov,
          coefficientOfVariationThreshold: MAX_COEFFICIENT_OF_VARIATION,
          conversionUpliftFactor: OUTCOME_CONVERSION_UPLIFT,
          minBaselineUsd: MIN_BASELINE_USD,
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
