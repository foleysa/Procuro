import { describe, it, expect } from "vitest";
import { s2pForStatusTransition, BACKFILL_DEFAULTS } from "../src/s2p-helpers";

describe("s2pForStatusTransition — backfill mapping", () => {
  it("proposed → Identified / Identified", () => {
    const result = s2pForStatusTransition("proposed");
    expect(result.canonicalStage).toBe("Identified");
    expect(result.savingsType).toBe("Identified");
  });

  it("approved → Awarded / Negotiated", () => {
    const result = s2pForStatusTransition("approved");
    expect(result.canonicalStage).toBe("Awarded");
    expect(result.savingsType).toBe("Negotiated");
  });

  it("executing → In Implementation / Implemented", () => {
    const result = s2pForStatusTransition("executing");
    expect(result.canonicalStage).toBe("In Implementation");
    expect(result.savingsType).toBe("Implemented");
  });

  it("realized → Realized / Realized", () => {
    const result = s2pForStatusTransition("realized");
    expect(result.canonicalStage).toBe("Realized");
    expect(result.savingsType).toBe("Realized");
  });

  it("rejected → Closed-No Action / Identified", () => {
    const result = s2pForStatusTransition("rejected");
    expect(result.canonicalStage).toBe("Closed-No Action");
    expect(result.savingsType).toBe("Identified");
  });

  it("expired → Closed-No Action / Identified", () => {
    const result = s2pForStatusTransition("expired");
    expect(result.canonicalStage).toBe("Closed-No Action");
    expect(result.savingsType).toBe("Identified");
  });

  it("unknown status defaults to Identified / Identified", () => {
    const result = s2pForStatusTransition("something_unknown");
    expect(result.canonicalStage).toBe("Identified");
    expect(result.savingsType).toBe("Identified");
  });
});

describe("BACKFILL_DEFAULTS", () => {
  it("classificationNeedsReview is true", () => {
    expect(BACKFILL_DEFAULTS.classificationNeedsReview).toBe(true);
  });

  it("baselineMethod is Internal Estimate", () => {
    expect(BACKFILL_DEFAULTS.baselineMethod).toBe("Internal Estimate");
  });

  it("baselineValue is null", () => {
    expect(BACKFILL_DEFAULTS.baselineValue).toBeNull();
  });

  it("sourcingStrategy is Unclassified", () => {
    expect(BACKFILL_DEFAULTS.sourcingStrategy).toBe("Unclassified");
  });

  it("savingsClassification is Hard", () => {
    expect(BACKFILL_DEFAULTS.savingsClassification).toBe("Hard");
  });

  it("baselineSource is BACKFILL — needs review", () => {
    expect(BACKFILL_DEFAULTS.baselineSource).toBe("BACKFILL — needs review");
  });
});
