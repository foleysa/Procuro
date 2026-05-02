import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AnalyzeResult, LeverAnalyzer, OpportunityDraft } from "../types";

/**
 * Lever — SOW scope management (Tier 5).
 *
 * Two trigger conditions, either of which fires the lever:
 *
 *   1. **Dollar over-run.** `committedValue / NTE > 1.10` — committed
 *      value (SOW totalValueUsd + sum of approved/executed change
 *      orders) has crept more than 10% above the original NTE.
 *   2. **Change-order count.** `>= 3` change orders against a single
 *      SOW, regardless of dollar threshold — a discipline signal in
 *      its own right.
 *
 * Sized savings = `committedValue - NTE` (the overrun itself is
 * future-avoidable spend); the count-only branch sizes against the
 * sum of executed change-order deltas as a proxy.
 *
 * Tenant-data only — no market signals consulted.
 */

const OVERRUN_RATIO_THRESHOLD = 1.10;
const CHANGE_ORDER_COUNT_THRESHOLD = 3;
const MIN_SAVINGS_USD = 500;

const dollars = (n: number) => Math.round(n * 100) / 100;

interface ScopeRow {
  sow_id: string;
  sow_number: string;
  sow_title: string;
  supplier_id: string;
  supplier_name: string;
  contract_id: string;
  total_value_usd: string | null;
  end_date: string;
  approved_delta_usd: string;
  proposed_delta_usd: string;
  approved_count: string;
  total_count: string;
  /** Sum of `time_entries.amount_usd` for this SOW over the trailing 30 days. */
  burn_30d_usd: string;
  /** Days from now to `end_date`; <=0 if the SOW has already lapsed. */
  remaining_days: string;
}

export const scopeManagementLever: LeverAnalyzer = {
  leverId: "scope_management",
  tier: 5,
  label: "SOW Scope Management",
  description:
    "Active SOWs whose committed value (SOW total + approved/executed change orders) has crept >10% above the original not-to-exceed, or where >=3 change orders signal poor scope discipline. Surfaces the trail and sizes against the over-run.",
  cohortKey(draft: OpportunityDraft): string {
    const inputs = (draft.inputs as Record<string, unknown>) ?? {};
    const sowId = inputs["sowId"];
    return typeof sowId === "string" ? sowId : "";
  },
  async analyze({ orgId }) {
    const rows = (await db.execute(sql`
      WITH co_agg AS (
        SELECT co.sow_id,
               COALESCE(SUM(CASE
                 WHEN co.status IN ('approved', 'executed')
                 THEN co.value_delta_usd::numeric ELSE 0 END), 0) AS approved_delta,
               COALESCE(SUM(CASE
                 WHEN co.status = 'proposed'
                 THEN co.value_delta_usd::numeric ELSE 0 END), 0) AS proposed_delta,
               COUNT(*) FILTER (WHERE co.status IN ('approved', 'executed')) AS approved_count,
               COUNT(*) AS total_count
        FROM sow_change_orders co
        WHERE co.org_id = ${orgId}
        GROUP BY co.sow_id
      ),
      burn AS (
        SELECT te.sow_id,
               COALESCE(SUM(te.amount_usd::numeric), 0) AS burn_30d
        FROM time_entries te
        WHERE te.org_id = ${orgId}
          AND te.work_date >= NOW() - INTERVAL '30 days'
          AND te.sow_id IS NOT NULL
        GROUP BY te.sow_id
      )
      SELECT sow.id          AS sow_id,
             sow.sow_number,
             sow.title       AS sow_title,
             sow.supplier_id,
             s.name          AS supplier_name,
             sow.contract_id,
             sow.total_value_usd,
             sow.end_date::text AS end_date,
             COALESCE(co_agg.approved_delta, 0)::text   AS approved_delta_usd,
             COALESCE(co_agg.proposed_delta, 0)::text   AS proposed_delta_usd,
             COALESCE(co_agg.approved_count, 0)::text   AS approved_count,
             COALESCE(co_agg.total_count, 0)::text      AS total_count,
             COALESCE(burn.burn_30d, 0)::text           AS burn_30d_usd,
             GREATEST(0, EXTRACT(EPOCH FROM (sow.end_date - NOW())) / 86400)::text
                                                        AS remaining_days
      FROM statements_of_work sow
      JOIN suppliers s ON s.id = sow.supplier_id
      LEFT JOIN co_agg ON co_agg.sow_id = sow.id
      LEFT JOIN burn   ON burn.sow_id   = sow.id
      WHERE sow.org_id = ${orgId}
        AND sow.status = 'active'
        AND sow.total_value_usd IS NOT NULL
    `)).rows as unknown as ScopeRow[];

    const drafts: OpportunityDraft[] = [];
    for (const r of rows) {
      const nte = Number(r.total_value_usd);
      if (!isFinite(nte) || nte <= 0) continue;
      const approvedDelta = Number(r.approved_delta_usd);
      const proposedDelta = Number(r.proposed_delta_usd);
      const totalCount = Number(r.total_count);
      const approvedCount = Number(r.approved_count);
      const committedValue = nte + approvedDelta;
      const overrunRatio = committedValue / nte;
      const overrunUsd = committedValue - nte;

      const dollarTrigger = overrunRatio > OVERRUN_RATIO_THRESHOLD;
      const countTrigger = totalCount >= CHANGE_ORDER_COUNT_THRESHOLD;
      if (!dollarTrigger && !countTrigger) continue;

      // Forward projection: remaining runway × current burn rate.
      // The lever's actionable savings are not just today's overrun
      // but also the spend the SOW will continue to accrue if nothing
      // changes — we add `(burn_30d / 30) * remainingDays` on top of
      // the current overrun so the sized opportunity reflects the
      // total avoidable cost over the remaining contract.
      const burn30 = Math.max(0, Number(r.burn_30d_usd) || 0);
      const burnPerDay = burn30 / 30;
      const remainingDays = Math.max(0, Number(r.remaining_days) || 0);
      const projectedRemainingSpend = burnPerDay * remainingDays;
      const currentOverrun = Math.max(0, overrunUsd);

      // Size savings on the over-run + forward projection when the
      // dollar trigger fires, otherwise on the approved-delta total
      // (the count-only branch).
      const savings = dollarTrigger
        ? currentOverrun + projectedRemainingSpend
        : Math.max(approvedDelta, 0) + projectedRemainingSpend;
      if (savings < MIN_SAVINGS_USD && dollarTrigger) continue;

      const triggerLabel = dollarTrigger
        ? `${(overrunRatio * 100 - 100).toFixed(1)}% over original NTE`
        : `${totalCount} change orders against original scope`;

      drafts.push({
        leverId: "scope_management",
        title: `Scope creep on SOW ${r.sow_number} (${r.supplier_name}) — ${triggerLabel}`,
        rationale: `SOW ${r.sow_number} ("${r.sow_title}") with ${r.supplier_name} has an original NTE of $${nte.toFixed(0)} and ${approvedCount} approved/executed change orders worth $${approvedDelta.toFixed(0)}, taking committed value to $${committedValue.toFixed(0)} (${(overrunRatio * 100).toFixed(1)}% of NTE). ${totalCount} change orders total (${proposedDelta > 0 ? `$${proposedDelta.toFixed(0)} additional value sits in proposed status` : "no further proposed deltas"}). Trailing-30 burn $${burn30.toFixed(0)} ($${burnPerDay.toFixed(0)}/day) × ${remainingDays.toFixed(0)} days remaining projects another ~$${projectedRemainingSpend.toFixed(0)} of forward spend.`,
        recommendedAction: dollarTrigger
          ? `Pause approval of any further change orders pending a re-baseline; require the supplier to issue a fresh NTE rather than continuing to chain change orders. Open a CFO-level conversation if the next request would push the run-rate past 1.25× original.`
          : `Audit the change-order trail: ${totalCount} CRs on a single SOW signals scope was under-defined at signing. Tighten acceptance criteria and require a single consolidated change order on the next request.`,
        supplierId: r.supplier_id,
        rawProjectedSavingsUsd: dollars(savings),
        inputs: {
          sowId: r.sow_id,
          sowNumber: r.sow_number,
          contractId: r.contract_id,
          supplierId: r.supplier_id,
          nteUsd: nte,
          committedValueUsd: committedValue,
          approvedDeltaUsd: approvedDelta,
          proposedDeltaUsd: proposedDelta,
          overrunRatio,
          overrunUsd,
          changeOrderCount: totalCount,
          approvedChangeOrderCount: approvedCount,
          triggerKind: dollarTrigger ? "dollar_overrun" : "change_order_count",
          overrunRatioThreshold: OVERRUN_RATIO_THRESHOLD,
          changeOrderCountThreshold: CHANGE_ORDER_COUNT_THRESHOLD,
          burn30dUsd: burn30,
          burnPerDayUsd: burnPerDay,
          remainingDays,
          projectedRemainingSpendUsd: projectedRemainingSpend,
          projectedFinalCommittedUsd: committedValue + projectedRemainingSpend,
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
