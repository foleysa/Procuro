import { describe, it, expect } from "vitest";
import { makeBackfilledOpportunity } from "./fixtures/factory";
import { BACKFILL_DEFAULTS } from "../src/s2p-helpers";

describe("backfill review flag — factory produces correct defaults", () => {
  it("classification_needs_review is true", () => {
    const opp = makeBackfilledOpportunity();
    expect(opp.classificationNeedsReview).toBe(true);
  });

  it("baseline_method is Internal Estimate", () => {
    const opp = makeBackfilledOpportunity();
    expect(opp.baselineMethod).toBe("Internal Estimate");
  });

  it("baseline_value is null", () => {
    const opp = makeBackfilledOpportunity();
    expect(opp.baselineValue).toBeNull();
  });

  it("sourcing_strategy is Unclassified", () => {
    const opp = makeBackfilledOpportunity();
    expect(opp.sourcingStrategy).toBe("Unclassified");
  });

  it("savings_classification is Hard", () => {
    const opp = makeBackfilledOpportunity();
    expect(opp.savingsClassification).toBe("Hard");
  });

  it("baseline_source is BACKFILL — needs review", () => {
    const opp = makeBackfilledOpportunity();
    expect(opp.baselineSource).toBe("BACKFILL — needs review");
  });

  it("factory defaults match BACKFILL_DEFAULTS constants", () => {
    const opp = makeBackfilledOpportunity();
    expect(opp.classificationNeedsReview).toBe(
      BACKFILL_DEFAULTS.classificationNeedsReview,
    );
    expect(opp.baselineMethod).toBe(BACKFILL_DEFAULTS.baselineMethod);
    expect(opp.baselineValue).toBe(BACKFILL_DEFAULTS.baselineValue);
    expect(opp.sourcingStrategy).toBe(BACKFILL_DEFAULTS.sourcingStrategy);
    expect(opp.savingsClassification).toBe(
      BACKFILL_DEFAULTS.savingsClassification,
    );
  });

  it("overrides are applied on top of backfill defaults", () => {
    const opp = makeBackfilledOpportunity({
      savingsClassification: "Cost Avoidance",
      classificationNeedsReview: false,
    });
    expect(opp.savingsClassification).toBe("Cost Avoidance");
    expect(opp.classificationNeedsReview).toBe(false);
    expect(opp.baselineMethod).toBe("Internal Estimate");
  });
});
