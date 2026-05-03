import { describe, it, expect } from "vitest";
import {
  resolveDoaTier,
  resolveDoaTierNumber,
} from "../src/doa-config";

describe("resolveDoaTierNumber — boundary values", () => {
  it("$249,999 → Tier 4", () => {
    expect(resolveDoaTierNumber(249_999)).toBe(4);
  });

  it("$250,000 → Tier 3", () => {
    expect(resolveDoaTierNumber(250_000)).toBe(3);
  });

  it("$999,999 → Tier 3", () => {
    expect(resolveDoaTierNumber(999_999)).toBe(3);
  });

  it("$1,000,000 → Tier 2", () => {
    expect(resolveDoaTierNumber(1_000_000)).toBe(2);
  });

  it("$4,999,999 → Tier 2", () => {
    expect(resolveDoaTierNumber(4_999_999)).toBe(2);
  });

  it("$5,000,000 → Tier 1", () => {
    expect(resolveDoaTierNumber(5_000_000)).toBe(1);
  });

  it("$0 → Tier 4", () => {
    expect(resolveDoaTierNumber(0)).toBe(4);
  });

  it("very large value ($100M) → Tier 1", () => {
    expect(resolveDoaTierNumber(100_000_000)).toBe(1);
  });

  it("negative value → Tier 4", () => {
    expect(resolveDoaTierNumber(-500)).toBe(4);
  });
});

describe("resolveDoaTier — returns full config", () => {
  it("Tier 1 approverRole is board", () => {
    expect(resolveDoaTier(5_000_000).approverRole).toBe("board");
  });

  it("Tier 2 approverRole is c_suite", () => {
    expect(resolveDoaTier(1_000_000).approverRole).toBe("c_suite");
  });

  it("Tier 3 approverRole is vp", () => {
    expect(resolveDoaTier(250_000).approverRole).toBe("vp");
  });

  it("Tier 4 approverRole is manager", () => {
    expect(resolveDoaTier(0).approverRole).toBe("manager");
  });

  it("returns label for each tier", () => {
    expect(resolveDoaTier(5_000_000).label).toContain("Strategic");
    expect(resolveDoaTier(1_000_000).label).toContain("Major");
    expect(resolveDoaTier(250_000).label).toContain("Significant");
    expect(resolveDoaTier(0).label).toContain("Standard");
  });
});
