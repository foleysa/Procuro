/**
 * Soak-test data seeder — produces 50,000 opportunities with ~150,000
 * stage history rows under a dedicated soak-test org.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed-soak-data
 *   pnpm --filter @workspace/scripts run seed-soak-data -- --dry-run
 *
 * Idempotency:
 *   Deletes all prior soak data (org_id = 'org_soak_test') before seeding.
 *   Safe to re-run.
 *
 * Data shape:
 *   - 50,000 opportunities spread across all lever IDs with realistic
 *     status distributions matching production patterns.
 *   - ~3 stage history rows per opportunity (avg), producing ~150K rows.
 *   - Dates span the last 12 months to simulate long-running accumulation.
 *   - DOA tiers, savings values, and stage timings follow realistic
 *     distributions so query plans exercise the same code paths as prod.
 */
import {
  db,
  pool,
  orgsTable,
  opportunitiesTable,
  opportunityStageHistoryTable,
  suppliersTable,
  categoriesTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import type {
  LeverId,
  OpportunityStatus,
  CanonicalStage,
  SavingsType,
  SavingsClassification,
  SourcingStrategy,
} from "@workspace/db";

const SOAK_ORG_ID = "org_soak_test";
const SOAK_ORG_SLUG = "soak-test";
const SOAK_ORG_NAME = "Soak Test Org";
const TOTAL_OPPORTUNITIES = 50_000;
const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes("--dry-run");

const LEVER_IDS: LeverId[] = [
  "sku_price_benchmark",
  "maverick_spend",
  "contract_leakage",
  "duplicate_payment",
  "missed_volume_threshold",
  "payment_term_extension",
  "tail_spend_rationalization",
  "supplier_consolidation",
  "contract_renegotiation_trigger",
  "spot_vs_contract",
  "catalog_standardization",
  "indirect_category_strategy",
  "freight_mode_optimization",
  "lane_consolidation",
  "incoterms_optimization",
  "should_cost_modeling",
  "index_based_pricing",
  "demand_aggregation",
];

const STATUS_DISTRIBUTION: Array<{
  status: OpportunityStatus;
  weight: number;
}> = [
  { status: "proposed", weight: 0.35 },
  { status: "approved", weight: 0.2 },
  { status: "executing", weight: 0.15 },
  { status: "realized", weight: 0.15 },
  { status: "rejected", weight: 0.1 },
  { status: "expired", weight: 0.05 },
];

const STAGE_MAP: Record<
  OpportunityStatus,
  { stage: CanonicalStage; savingsType: SavingsType }
> = {
  proposed: { stage: "Identified", savingsType: "Identified" },
  approved: { stage: "Awarded", savingsType: "Negotiated" },
  executing: { stage: "In Implementation", savingsType: "Implemented" },
  realized: { stage: "Realized", savingsType: "Realized" },
  rejected: { stage: "Closed-No Action", savingsType: "Identified" },
  expired: { stage: "Closed-No Action", savingsType: "Identified" },
};

const STAGE_TRANSITIONS: Record<OpportunityStatus, CanonicalStage[]> = {
  proposed: ["Identified"],
  approved: ["Identified", "Awarded"],
  executing: ["Identified", "Awarded", "In Implementation"],
  realized: ["Identified", "Awarded", "In Implementation", "Realized"],
  rejected: ["Identified", "Closed-No Action"],
  expired: ["Identified", "Closed-No Action"],
};

const CLASSIFICATIONS: SavingsClassification[] = [
  "Hard",
  "Cost Avoidance",
  "Soft",
];
const STRATEGIES: SourcingStrategy[] = [
  "Competitive RFP",
  "Single-to-Dual Source",
  "Should-Cost Challenge",
  "Negotiated Renewal",
  "Unclassified",
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function pickWeighted<T>(items: Array<{ value: T; weight: number }>): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.value;
  }
  return items[items.length - 1]!.value;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)]!;
}

function newId(prefix: string): string {
  const hex = Array.from({ length: 18 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `${prefix}_${hex}`;
}

function randomDateInLastMonths(months: number): Date {
  const now = Date.now();
  const past = now - months * 30 * 24 * 60 * 60 * 1000;
  return new Date(past + Math.random() * (now - past));
}

function resolveTier(usd: number): 1 | 2 | 3 | 4 {
  if (usd >= 5_000_000) return 1;
  if (usd >= 1_000_000) return 2;
  if (usd >= 250_000) return 3;
  return 4;
}

function generateSavingsUsd(): number {
  const r = Math.random();
  if (r < 0.5) return randomFloat(10_000, 250_000);
  if (r < 0.8) return randomFloat(250_000, 1_000_000);
  if (r < 0.95) return randomFloat(1_000_000, 5_000_000);
  return randomFloat(5_000_000, 20_000_000);
}

async function ensureSoakOrg(): Promise<void> {
  await db
    .insert(orgsTable)
    .values({ id: SOAK_ORG_ID, slug: SOAK_ORG_SLUG, name: SOAK_ORG_NAME })
    .onConflictDoNothing();
  console.log(`[soak] org ${SOAK_ORG_ID} ensured`);
}

async function cleanPriorData(): Promise<void> {
  console.log(`[soak] cleaning prior soak data for ${SOAK_ORG_ID}...`);
  await db.execute(
    sql`DELETE FROM opportunity_stage_history WHERE org_id = ${SOAK_ORG_ID}`,
  );
  await db.execute(
    sql`DELETE FROM opportunities WHERE org_id = ${SOAK_ORG_ID}`,
  );
  console.log(`[soak] prior data cleaned`);
}

async function seedOpportunities(): Promise<void> {
  const totalBatches = Math.ceil(TOTAL_OPPORTUNITIES / BATCH_SIZE);
  let totalHistoryRows = 0;

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchStart = batch * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_OPPORTUNITIES);
    const oppRows: Array<typeof opportunitiesTable.$inferInsert> = [];
    const historyRows: Array<
      typeof opportunityStageHistoryTable.$inferInsert
    > = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const status = pickWeighted(
        STATUS_DISTRIBUTION.map((s) => ({ value: s.status, weight: s.weight })),
      );
      const mapping = STAGE_MAP[status]!;
      const leverId = pick(LEVER_IDS);
      const projectedUsd = generateSavingsUsd();
      const rawUsd = projectedUsd * randomFloat(1.0, 1.3);
      const confidence = randomFloat(0.4, 0.98);
      const doaTier = resolveTier(projectedUsd);
      const cycleId = `cycle_soak_${randomInt(1, 200)}`;
      const createdAt = randomDateInLastMonths(12);
      const stageEnteredAt = new Date(
        createdAt.getTime() + randomInt(0, 30 * 24 * 60 * 60 * 1000),
      );
      const oppId = newId("opp");

      const realizedSavingsUsd =
        status === "realized"
          ? (projectedUsd * randomFloat(0.6, 1.1)).toFixed(2)
          : "0";
      const realizedAt =
        status === "realized"
          ? new Date(
              stageEnteredAt.getTime() + randomInt(1, 90) * 24 * 60 * 60 * 1000,
            )
          : undefined;

      oppRows.push({
        id: oppId,
        orgId: SOAK_ORG_ID,
        cycleId,
        leverId,
        tier: doaTier,
        title: `Soak opp #${i + 1} — ${leverId}`,
        rationale: `Auto-generated soak test opportunity for load/stress/soak testing`,
        recommendedAction: `Review and action soak opportunity ${i + 1}`,
        projectedSavingsUsd: projectedUsd.toFixed(2),
        rawProjectedSavingsUsd: rawUsd.toFixed(2),
        confidence: confidence.toFixed(4),
        inputs: { soakTest: true, batchIndex: batch },
        status,
        realizedSavingsUsd,
        realizedAt,
        canonicalStage: mapping.stage,
        stageEnteredAt,
        savingsType: mapping.savingsType,
        savingsClassification: pick(CLASSIFICATIONS),
        classificationNeedsReview: Math.random() > 0.7,
        doaTier,
        sourcingStrategy: pick(STRATEGIES),
        baselineMethod: "Internal Estimate",
        baselineSource: "SOAK_SEED",
        signalKey: `soak_${leverId}_${i}`,
        lastSeenAt: new Date(
          createdAt.getTime() + randomInt(0, 60) * 24 * 60 * 60 * 1000,
        ),
        createdAt,
      });

      const transitions = STAGE_TRANSITIONS[status]!;
      let prevStage: CanonicalStage | null = null;
      let transitionTime = new Date(createdAt);
      for (const toStage of transitions) {
        historyRows.push({
          id: newId("sh"),
          opportunityId: oppId,
          orgId: SOAK_ORG_ID,
          fromStage: prevStage ?? undefined,
          toStage,
          transitionedAt: transitionTime,
          transitionReason: prevStage === null ? "BACKFILL" : "STATUS_CHANGE",
        });
        prevStage = toStage;
        transitionTime = new Date(
          transitionTime.getTime() +
            randomInt(1, 14) * 24 * 60 * 60 * 1000,
        );
      }
      totalHistoryRows += transitions.length;
    }

    if (!DRY_RUN) {
      await db.insert(opportunitiesTable).values(oppRows);
      await db.insert(opportunityStageHistoryTable).values(historyRows);
    }

    const pct = (((batch + 1) / totalBatches) * 100).toFixed(1);
    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      console.log(
        `[soak] batch ${batch + 1}/${totalBatches} (${pct}%) — ${batchEnd} opps, ${totalHistoryRows} history rows so far`,
      );
    }
  }

  console.log(
    `[soak] seeded ${TOTAL_OPPORTUNITIES} opportunities and ${totalHistoryRows} stage history rows`,
  );
}

async function main(): Promise<void> {
  console.log(
    `[soak] starting${DRY_RUN ? " (DRY RUN)" : ""} at ${new Date().toISOString()}`,
  );

  if (DRY_RUN) {
    console.log(
      `[soak] would seed ${TOTAL_OPPORTUNITIES} opportunities with ~150K history rows`,
    );
    console.log(`[soak] dry run complete`);
    return;
  }

  await ensureSoakOrg();
  await cleanPriorData();
  await seedOpportunities();
  console.log(`[soak] complete`);
}

main()
  .catch((err) => {
    console.error("[soak] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
