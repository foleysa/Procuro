import { describe, it, expect } from "vitest";
import { validateBaselineForRealized } from "../src/s2p-helpers";

describe("validateBaselineForRealized", () => {
  it("non-Realized savings type is always valid", () => {
    const result = validateBaselineForRealized({
      savingsType: "Identified",
      baselineValue: null,
      baselineMethod: null,
    });
    expect(result.valid).toBe(true);
  });

  it("Realized with non-null baselineValue is valid", () => {
    const result = validateBaselineForRealized({
      savingsType: "Realized",
      baselineValue: "1500.00",
      baselineMethod: "Prior Unit Price",
    });
    expect(result.valid).toBe(true);
  });

  it("Realized with baselineMethod = 'N/A — Soft' and null baselineValue is valid", () => {
    const result = validateBaselineForRealized({
      savingsType: "Realized",
      baselineValue: null,
      baselineMethod: "N/A — Soft",
    });
    expect(result.valid).toBe(true);
  });

  it("Realized with null baselineValue and non-soft baselineMethod is invalid", () => {
    const result = validateBaselineForRealized({
      savingsType: "Realized",
      baselineValue: null,
      baselineMethod: "Internal Estimate",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("Realized with null baselineValue and null baselineMethod is invalid", () => {
    const result = validateBaselineForRealized({
      savingsType: "Realized",
      baselineValue: null,
      baselineMethod: null,
    });
    expect(result.valid).toBe(false);
  });

  it("null savingsType is valid (not Realized)", () => {
    const result = validateBaselineForRealized({
      savingsType: null,
      baselineValue: null,
      baselineMethod: null,
    });
    expect(result.valid).toBe(true);
  });
});
