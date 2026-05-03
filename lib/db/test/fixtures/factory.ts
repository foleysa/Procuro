import { faker } from "@faker-js/faker";
import type { InsertOpportunityRow } from "../../src/schema/opportunities";

export function makeUser(overrides: { id?: string; email?: string } = {}) {
  return {
    id: overrides.id ?? faker.string.uuid(),
    email: overrides.email ?? faker.internet.email(),
  };
}

export function makeOpportunity(
  overrides: Partial<InsertOpportunityRow> = {},
): InsertOpportunityRow {
  const id = overrides.id ?? `opp_${faker.string.nanoid(12)}`;
  const orgId = overrides.orgId ?? `org_${faker.string.nanoid(8)}`;
  const projectedSavingsUsd =
    overrides.projectedSavingsUsd ??
    faker.number.float({ min: 10_000, max: 10_000_000 }).toFixed(2);

  return {
    id,
    orgId,
    cycleId: overrides.cycleId ?? `cyc_${faker.string.nanoid(8)}`,
    leverId: overrides.leverId ?? "sku_price_benchmark",
    tier: overrides.tier ?? 1,
    title: overrides.title ?? faker.commerce.productName(),
    rationale: overrides.rationale ?? faker.lorem.sentence(),
    recommendedAction:
      overrides.recommendedAction ?? faker.lorem.sentence(),
    rawProjectedSavingsUsd:
      overrides.rawProjectedSavingsUsd ?? projectedSavingsUsd,
    projectedSavingsUsd,
    confidence: overrides.confidence ?? "0.7500",
    inputs: overrides.inputs ?? {},
    status: overrides.status ?? "proposed",
    realizedSavingsUsd: overrides.realizedSavingsUsd ?? "0",
    savingsType: overrides.savingsType ?? "Identified",
    savingsClassification: overrides.savingsClassification ?? "Hard",
    classificationNeedsReview: overrides.classificationNeedsReview ?? false,
    canonicalStage: overrides.canonicalStage ?? "Identified",
    stageEnteredAt: overrides.stageEnteredAt ?? new Date(),
    doaTier: overrides.doaTier ?? 4,
    sourcingStrategy: overrides.sourcingStrategy ?? "Unclassified",
    baselineMethod: overrides.baselineMethod ?? "Internal Estimate",
    baselineValue: overrides.baselineValue ?? null,
    baselineSource: overrides.baselineSource ?? null,
    ...overrides,
  };
}

export function makeBackfilledOpportunity(
  overrides: Partial<InsertOpportunityRow> = {},
): InsertOpportunityRow {
  return makeOpportunity({
    savingsClassification: "Hard",
    classificationNeedsReview: true,
    baselineMethod: "Internal Estimate",
    baselineValue: null,
    baselineSource: "BACKFILL — needs review",
    sourcingStrategy: "Unclassified",
    ...overrides,
  });
}
