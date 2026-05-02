import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "../types";

/**
 * Lever — Hours audit / T&M burn-rate (Tier 5).
 *
 * Two complementary detections folded into one lever:
 *
 *   1. **Burn-rate over-run.** For each active SOW with time entries,
 *      compute the trailing-30-day burn (USD/week) and project it
 *      forward to `endDate`. If `burned + projectedRemaining > NTE *
 *      1.05`, emit an SOW-level opportunity sized at the projected
 *      over-run.
 *   2. **Per-person utilisation anomalies.** Group entries by
 *      `(sowId, resource)` over the trailing 4 weeks. Sustained
 *      `> 60h/wk` flags overload (rework risk); sustained `< 10h/wk`
 *      flags parking (rate-card waste).
 *
 * Tenant-data only — no market signals consulted.
 */

const OVERRUN_RATIO_THRESHOLD = 1.05;
const OVERLOAD_HOURS_PER_WEEK = 60;
const UNDERUSE_HOURS_PER_WEEK = 10;
const UTILISATION_LOOKBACK_WEEKS = 4;
const MIN_SAVINGS_USD = 500;

const dollars = (n: number) => Math.round(n * 100) / 100;

interface SowBurnRow {
  sow_id: string;
  sow_number: string;
  sow_title: string;
  supplier_id: string;
  supplier_name: string;
  total_value_usd: string | null;
  end_date: string;
  total_burned_usd: string;
  total_burned_hours: string;
  burn_30d_usd: string;
  burn_30d_hours: string;
}

interface PersonUtilRow {
  sow_id: string;
  sow_number: string;
  supplier_id: string;
  supplier_name: string;
  resource: string;
  total_hours: string;
  total_amount_usd: string | null;
  weeks_active: string;
  avg_bill_rate_usd: string | null;
}

export const hoursAuditLever: LeverAnalyzer = {
  leverId: "hours_audit",
  tier: 5,
  label: "T&M Hours Audit",
  description:
    "Active SOWs whose trailing-30-day burn rate projects past NTE before completion, plus per-person utilisation anomalies (sustained >60h/wk overload, <10h/wk parking). Sizes against projected over-run and observed waste.",
  cohortKey(draft: OpportunityDraft): string {
    const inputs = (draft.inputs as Record<string, unknown>) ?? {};
    const sowId = inputs["sowId"];
    const person = inputs["personIdentifier"];
    const base = typeof sowId === "string" ? sowId : "";
    return typeof person === "string" ? `${base}:${person}` : base;
  },
  async analyze({ orgId }) {
    // 1. Per-SOW burn-rate aggregation.
    const sowRows = (await db.execute(sql`
      WITH burn AS (
        SELECT te.sow_id,
               SUM(te.hours::numeric)                             AS total_hours,
               COALESCE(SUM(te.amount_usd::numeric), 0)           AS total_amount,
               SUM(CASE WHEN te.work_date >= NOW() - INTERVAL '30 days'
                        THEN te.hours::numeric ELSE 0 END)         AS hours_30d,
               COALESCE(SUM(CASE WHEN te.work_date >= NOW() - INTERVAL '30 days'
                        THEN te.amount_usd::numeric ELSE 0 END), 0) AS amount_30d
        FROM time_entries te
        WHERE te.org_id = ${orgId} AND te.sow_id IS NOT NULL
        GROUP BY te.sow_id
      )
      SELECT sow.id          AS sow_id,
             sow.sow_number,
             sow.title       AS sow_title,
             sow.supplier_id,
             s.name          AS supplier_name,
             sow.total_value_usd,
             sow.end_date::text                AS end_date,
             COALESCE(burn.total_amount, 0)::text   AS total_burned_usd,
             COALESCE(burn.total_hours, 0)::text    AS total_burned_hours,
             COALESCE(burn.amount_30d, 0)::text     AS burn_30d_usd,
             COALESCE(burn.hours_30d, 0)::text      AS burn_30d_hours
      FROM statements_of_work sow
      JOIN suppliers s ON s.id = sow.supplier_id
      JOIN burn ON burn.sow_id = sow.id
      WHERE sow.org_id = ${orgId}
        AND sow.status = 'active'
        AND sow.total_value_usd IS NOT NULL
    `)).rows as unknown as SowBurnRow[];

    const drafts: OpportunityDraft[] = [];
    const now = Date.now();

    for (const r of sowRows) {
      const nte = Number(r.total_value_usd);
      if (!isFinite(nte) || nte <= 0) continue;
      const burned = Number(r.total_burned_usd);
      const burned30dUsd = Number(r.burn_30d_usd);
      const weeklyBurnRate = (burned30dUsd * 7) / 30;
      const endMs = new Date(r.end_date).getTime();
      const weeksRemaining = Math.max(0, (endMs - now) / (1000 * 60 * 60 * 24 * 7));
      const projectedAtCompletion = burned + weeklyBurnRate * weeksRemaining;
      if (projectedAtCompletion <= nte * OVERRUN_RATIO_THRESHOLD) continue;
      const overrun = projectedAtCompletion - nte;
      if (overrun < MIN_SAVINGS_USD) continue;

      drafts.push({
        leverId: "hours_audit",
        title: `Burn-rate alert: SOW ${r.sow_number} (${r.supplier_name}) projects $${projectedAtCompletion.toFixed(0)} vs NTE $${nte.toFixed(0)}`,
        rationale: `SOW ${r.sow_number} ("${r.sow_title}") with ${r.supplier_name} has burned $${burned.toFixed(0)} of its $${nte.toFixed(0)} NTE (${((burned / nte) * 100).toFixed(1)}%). Trailing-30-day burn is $${burned30dUsd.toFixed(0)} (~$${weeklyBurnRate.toFixed(0)}/week). With ${weeksRemaining.toFixed(1)} weeks of runway to ${r.end_date.slice(0, 10)}, the projected end-state is $${projectedAtCompletion.toFixed(0)} — $${overrun.toFixed(0)} above NTE.`,
        recommendedAction: `Cap further weekly hours at ${(nte / projectedAtCompletion * weeklyBurnRate).toFixed(0)}/week to land at NTE, or open a re-baseline conversation with the supplier now (before more time is burned at the current rate).`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(overrun),
        inputs: {
          flavor: "burn_overrun",
          sowId: r.sow_id,
          sowNumber: r.sow_number,
          supplierId: r.supplier_id,
          nteUsd: nte,
          burnedUsd: burned,
          burned30dUsd,
          weeklyBurnRateUsd: weeklyBurnRate,
          weeksRemaining,
          projectedAtCompletionUsd: projectedAtCompletion,
          overrunUsd: overrun,
          overrunRatioThreshold: OVERRUN_RATIO_THRESHOLD,
        },
      });
    }

    // 2. Per-person utilisation over the trailing 4 weeks.
    const personRows = (await db.execute(sql`
      SELECT te.sow_id,
             sow.sow_number,
             te.supplier_id,
             s.name           AS supplier_name,
             te.resource,
             SUM(te.hours::numeric)                            AS total_hours,
             COALESCE(SUM(te.amount_usd::numeric), 0)          AS total_amount_usd,
             COUNT(DISTINCT date_trunc('week', te.work_date))  AS weeks_active,
             AVG(te.bill_rate_usd::numeric)                    AS avg_bill_rate_usd
      FROM time_entries te
      JOIN statements_of_work sow ON sow.id = te.sow_id
      JOIN suppliers s ON s.id = te.supplier_id
      WHERE te.org_id = ${orgId}
        AND te.sow_id IS NOT NULL
        AND sow.status = 'active'
        AND te.work_date >= NOW() - make_interval(weeks => ${UTILISATION_LOOKBACK_WEEKS})
      GROUP BY te.sow_id, sow.sow_number, te.supplier_id, s.name, te.resource
      HAVING COUNT(DISTINCT date_trunc('week', te.work_date)) >= ${UTILISATION_LOOKBACK_WEEKS}
    `)).rows as unknown as PersonUtilRow[];

    for (const p of personRows) {
      const totalHours = Number(p.total_hours);
      const weeks = Number(p.weeks_active);
      if (!isFinite(weeks) || weeks <= 0) continue;
      const avgPerWeek = totalHours / weeks;
      const billRate = p.avg_bill_rate_usd
        ? Number(p.avg_bill_rate_usd)
        : null;
      const totalAmount = Number(p.total_amount_usd ?? 0);

      if (avgPerWeek > OVERLOAD_HOURS_PER_WEEK) {
        // Rework-risk sizing: 25% of the over-cap hours assumed at risk.
        const overHours = (avgPerWeek - 40) * weeks;
        const reworkHours = Math.max(0, overHours) * 0.25;
        const reworkRate = billRate ?? totalAmount / Math.max(1, totalHours);
        const savings = reworkHours * reworkRate;
        if (savings < MIN_SAVINGS_USD) continue;
        drafts.push({
          leverId: "hours_audit",
          title: `Overload alert: ${p.resource} on SOW ${p.sow_number} sustained ${avgPerWeek.toFixed(0)}h/wk`,
          rationale: `${p.resource} on SOW ${p.sow_number} (${p.supplier_name}) averaged ${avgPerWeek.toFixed(1)} hours/week over the last ${weeks} weeks (${totalHours.toFixed(0)} total, $${totalAmount.toFixed(0)}). Sustained loading above ${OVERLOAD_HOURS_PER_WEEK}h/wk correlates with rework / quality lapses; the avoidable rework on ${reworkHours.toFixed(0)} hours at ~$${reworkRate.toFixed(0)}/hr is ~$${savings.toFixed(0)}.`,
          recommendedAction: `Cap weekly hours for ${p.resource} at 50/wk and require the supplier to staff a backup; review deliverables produced under the overload window for rework signals.`,
          supplierId: p.supplier_id,
          rawProjectedSavingsUsd: dollars(savings),
          inputs: {
            flavor: "overload",
            sowId: p.sow_id,
            sowNumber: p.sow_number,
            supplierId: p.supplier_id,
            personIdentifier: p.resource,
            avgHoursPerWeek: avgPerWeek,
            weeksObserved: weeks,
            totalHours,
            totalAmountUsd: totalAmount,
            avgBillRateUsd: billRate,
            reworkHoursAtRisk: reworkHours,
            overloadHoursThreshold: OVERLOAD_HOURS_PER_WEEK,
          },
        });
      } else if (avgPerWeek < UNDERUSE_HOURS_PER_WEEK && totalHours > 0) {
        // Parking sizing: amount paid for the under-utilised hours.
        const reworkRate = billRate ?? totalAmount / Math.max(1, totalHours);
        const savings = totalHours * reworkRate * 0.25;
        if (savings < MIN_SAVINGS_USD) continue;
        drafts.push({
          leverId: "hours_audit",
          title: `Under-utilised: ${p.resource} on SOW ${p.sow_number} averaged ${avgPerWeek.toFixed(0)}h/wk`,
          rationale: `${p.resource} on SOW ${p.sow_number} (${p.supplier_name}) averaged ${avgPerWeek.toFixed(1)} hours/week over the last ${weeks} weeks (${totalHours.toFixed(0)} total). A consultant parked at this rate carries rate-card overhead without delivering proportionate output.`,
          recommendedAction: `Either reassign ${p.resource} off the SOW or convert their share to a project rate; rate-card hourly billing on parked resources is a recurring waste pattern.`,
          supplierId: p.supplier_id,
          rawProjectedSavingsUsd: dollars(savings),
          inputs: {
            flavor: "under_utilised",
            sowId: p.sow_id,
            sowNumber: p.sow_number,
            supplierId: p.supplier_id,
            personIdentifier: p.resource,
            avgHoursPerWeek: avgPerWeek,
            weeksObserved: weeks,
            totalHours,
            totalAmountUsd: totalAmount,
            avgBillRateUsd: billRate,
            underuseHoursThreshold: UNDERUSE_HOURS_PER_WEEK,
          },
        });
      }
    }

    const result: AnalyzeResult = {
      drafts,
      consultedSignalIds: [],
      candidatesEvaluated: sowRows.length + personRows.length,
    };
    return result;
  },
};
