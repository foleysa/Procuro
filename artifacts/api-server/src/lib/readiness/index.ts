import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { SAMPLE_DATA_SOURCE_SYSTEM } from "../onboarding/sample-data-constants";
import { buildLeverReadiness, getReadinessRules } from "./rules";
import type { ReadinessContext, ReadinessResult } from "./types";

export type { ReadinessResult, LeverReadiness, ReadinessBlocker } from "./types";

/**
 * Compute lever-by-lever data-readiness for a tenant.
 *
 * Runs each rule independently so a single failing rule never poisons
 * the whole response. Average lever score is the headline number shown
 * on the dashboard readiness card.
 */
export async function computeReadiness(
  ctx: ReadinessContext,
): Promise<ReadinessResult> {
  const rules = getReadinessRules();
  const levers = await Promise.all(
    rules.map(async (spec) => {
      try {
        const { blockers } = await spec.rule(ctx);
        return buildLeverReadiness(spec, blockers);
      } catch {
        return buildLeverReadiness(spec, [
          {
            id: `${spec.leverId}.error`,
            field: "internal",
            message: "Readiness check failed — investigate via the API logs.",
            missingPct: 100,
            missingCount: 0,
            totalCount: 0,
            fixUrl: "",
            hard: true,
          },
        ]);
      }
    }),
  );
  const overallScore =
    levers.length === 0
      ? 0
      : Math.round(
          levers.reduce((a, b) => a + b.score, 0) / levers.length,
        );
  const [hasIngestedData, sampleDataInstalled] = await Promise.all([
    tenantHasIngestedData(ctx.orgId),
    tenantHasSampleData(ctx.orgId),
  ]);
  return {
    overallScore,
    hasIngestedData,
    sampleDataInstalled,
    levers,
  };
}

async function tenantHasIngestedData(orgId: string): Promise<boolean> {
  const out = await db.execute(sql`
    SELECT (
      EXISTS (SELECT 1 FROM purchase_orders WHERE org_id = ${orgId})
      OR EXISTS (SELECT 1 FROM invoices WHERE org_id = ${orgId})
      OR EXISTS (SELECT 1 FROM contracts WHERE org_id = ${orgId})
    ) AS has_data
  `);
  return Boolean((out.rows[0] as { has_data: boolean } | undefined)?.has_data);
}

async function tenantHasSampleData(orgId: string): Promise<boolean> {
  const out = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM suppliers
       WHERE org_id = ${orgId}
         AND source_system = ${SAMPLE_DATA_SOURCE_SYSTEM}
      LIMIT 1
    ) AS installed
  `);
  return Boolean((out.rows[0] as { installed: boolean } | undefined)?.installed);
}
