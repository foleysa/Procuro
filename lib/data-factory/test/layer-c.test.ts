import { describe, expect, it } from "vitest";
import {
  dataFactoryDecideActions,
  dataFactoryLearnOutcomes,
  layerCTaxonomyPayload,
  parseDataFactoryLayerCLabel,
  suggestedDecideForObserveKind,
} from "../src/layer-c";

/** Locked to PR #30 Pulse Layer C — do not fork. */
const PR30_DECIDE = [
  "renegotiate",
  "dual_source",
  "switch_lane",
  "hold",
  "kill",
] as const;
const PR30_LEARN = ["saved", "missed", "unknown", "reversed"] as const;

describe("Layer C taxonomy (aligned with PR #30)", () => {
  it("uses the Pulse Decide/Learn enums", () => {
    expect([...dataFactoryDecideActions]).toEqual([...PR30_DECIDE]);
    expect([...dataFactoryLearnOutcomes]).toEqual([...PR30_LEARN]);
  });

  it("parses a decide label on a public signal", () => {
    const label = parseDataFactoryLayerCLabel({
      schemaVersion: 1,
      phase: "decide",
      publicSignalId: "src_fred:DCOILBRENTEU",
      packageId: "pkg_public_indices",
      decideAction: "renegotiate",
      learnOutcome: null,
      ownerRole: "category_owner",
      occurredAt: "2026-09-16T00:00:00.000Z",
    });
    expect(label?.decideAction).toBe("renegotiate");
    expect(label?.publicSignalId).toBe("src_fred:DCOILBRENTEU");
  });

  it("requires unknown Learn to be explicit and first-class", () => {
    const label = parseDataFactoryLayerCLabel({
      schemaVersion: 1,
      phase: "learn",
      publicSignalId: "sig_public_1",
      learnOutcome: "unknown",
      occurredAt: "2026-09-16T00:00:00.000Z",
    });
    expect(label?.learnOutcome).toBe("unknown");
  });

  it("rejects tenant stake fields on Day 0", () => {
    const label = parseDataFactoryLayerCLabel({
      schemaVersion: 1,
      phase: "decide",
      publicSignalId: "sig_public_1",
      decideAction: "hold",
      occurredAt: "2026-09-16T00:00:00.000Z",
      tenantLocalStakeUsd: 1_000_000,
    });
    expect(label).toBeNull();
  });

  it("rejects decide without an action and invented actions", () => {
    expect(
      parseDataFactoryLayerCLabel({
        schemaVersion: 1,
        phase: "decide",
        publicSignalId: "sig",
        occurredAt: "2026-09-16T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parseDataFactoryLayerCLabel({
        schemaVersion: 1,
        phase: "decide",
        publicSignalId: "sig",
        decideAction: "benchmark_peers",
        occurredAt: "2026-09-16T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("exposes suggested Decide actions without claiming outcomes", () => {
    expect(suggestedDecideForObserveKind.price_index).toContain("renegotiate");
    const payload = layerCTaxonomyPayload();
    expect(payload.attachTo).toMatch(/public Layer A/);
    expect(payload.fences.some((f) => f.includes("peer percentiles"))).toBe(
      true,
    );
  });
});
